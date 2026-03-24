import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tamerclaw_mobile/features/agents/agents_provider.dart';
import 'package:tamerclaw_mobile/features/auth/auth_provider.dart';

final telegramBotsProvider =
    StateNotifierProvider<TelegramBotsNotifier, TelegramBotsState>((ref) {
  final api = ref.watch(apiClientProvider);
  final agents = ref.watch(agentsProvider);
  final notifier = TelegramBotsNotifier(api);
  notifier.buildFromAgents(agents.agents);
  return notifier;
});

class TelegramBot {
  final String agentId;
  final String displayName;
  final String? username;
  final bool isOnline;
  final bool hasToken;
  final int sessions;

  const TelegramBot({
    required this.agentId,
    required this.displayName,
    this.username,
    this.isOnline = false,
    this.hasToken = false,
    this.sessions = 0,
  });
}

class TelegramBotsState {
  final List<TelegramBot> bots;
  final bool isLoading;
  final String? error;
  final bool relayBotActive;

  const TelegramBotsState({
    this.bots = const [],
    this.isLoading = false,
    this.error,
    this.relayBotActive = false,
  });

  TelegramBotsState copyWith({
    List<TelegramBot>? bots,
    bool? isLoading,
    String? error,
    bool? relayBotActive,
  }) {
    return TelegramBotsState(
      bots: bots ?? this.bots,
      isLoading: isLoading ?? this.isLoading,
      error: error,
      relayBotActive: relayBotActive ?? this.relayBotActive,
    );
  }
}

class TelegramBotsNotifier extends StateNotifier<TelegramBotsState> {
  final dynamic _api;

  TelegramBotsNotifier(this._api) : super(const TelegramBotsState());

  void buildFromAgents(List agents) {
    final bots = <TelegramBot>[];
    for (final agent in agents) {
      if (agent.hasToken || agent.telegramAccount != null) {
        bots.add(TelegramBot(
          agentId: agent.id,
          displayName: agent.displayName,
          username: agent.telegramAccount,
          isOnline: agent.isActive,
          hasToken: agent.hasToken,
          sessions: agent.sessions,
        ));
      }
    }
    state = state.copyWith(bots: bots);
  }

  Future<void> fetchTelegramConfig() async {
    if (_api == null) return;
    state = state.copyWith(isLoading: true, error: null);

    try {
      final result = await _api.get('/api/config');
      if (result is Map<String, dynamic>) {
        final hasRelay = result['hasSharedBotToken'] == true ||
            result['sharedBotToken'] != null;
        state = state.copyWith(isLoading: false, relayBotActive: hasRelay);
      } else {
        state = state.copyWith(isLoading: false);
      }
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }
}
