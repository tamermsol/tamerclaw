import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tamerclaw_mobile/core/api/api_endpoints.dart';
import 'package:tamerclaw_mobile/core/storage/secure_storage.dart';
import 'package:tamerclaw_mobile/features/auth/auth_provider.dart';
import 'package:tamerclaw_mobile/features/agents/agent_customization_provider.dart';
import 'package:tamerclaw_mobile/shared/models/agent.dart';

// ---------- Agents list ----------

final agentsProvider =
    StateNotifierProvider<AgentsNotifier, AgentsState>((ref) {
  final api = ref.watch(apiClientProvider);
  return AgentsNotifier(api)..fetchAgents();
});

final agentSearchQueryProvider = StateProvider<String>((ref) => '');

final filteredAgentsProvider = Provider<List<Agent>>((ref) {
  final state = ref.watch(agentsProvider);
  final query = ref.watch(agentSearchQueryProvider).toLowerCase();
  final customizations = ref.watch(agentCustomizationProvider);
  final recentIds = ref.watch(recentAgentIdsProvider);

  var agents = List<Agent>.from(state.agents);

  String nameOf(Agent a) =>
      customizations[a.id]?.customName ?? a.displayName;

  if (query.isNotEmpty) {
    agents = agents.where((a) {
      return nameOf(a).toLowerCase().contains(query) ||
          a.id.toLowerCase().contains(query) ||
          a.model.toLowerCase().contains(query) ||
          a.displayName.toLowerCase().contains(query);
    }).toList();
  }

  // Build recency index from recentAgentIds (lower index = more recent)
  final recencyMap = <String, int>{};
  for (int i = 0; i < recentIds.length; i++) {
    recencyMap[recentIds[i]] = i;
  }

  // Sort: by last chat interaction (most recent first), then by activity, then alphabetical
  agents.sort((a, b) {
    final aRecent = recencyMap[a.id];
    final bRecent = recencyMap[b.id];

    // Agents the user has chatted with come first, ordered by recency
    if (aRecent != null && bRecent != null) return aRecent.compareTo(bRecent);
    if (aRecent != null) return -1;
    if (bRecent != null) return 1;

    // Agents never chatted with: active first, then by lastActivity
    if (a.isActive && !b.isActive) return -1;
    if (!a.isActive && b.isActive) return 1;
    final aTime = a.lastActivity?.millisecondsSinceEpoch ?? 0;
    final bTime = b.lastActivity?.millisecondsSinceEpoch ?? 0;
    if (aTime != bTime) return bTime.compareTo(aTime);
    // Fallback: alphabetical
    return nameOf(a).toLowerCase().compareTo(nameOf(b).toLowerCase());
  });

  return agents;
});

// ---------- Recent agents ----------

final recentAgentIdsProvider =
    StateNotifierProvider<RecentAgentsNotifier, List<String>>((ref) {
  final storage = ref.read(secureStorageProvider);
  return RecentAgentsNotifier(storage);
});

final recentAgentsProvider = Provider<List<Agent>>((ref) {
  final ids = ref.watch(recentAgentIdsProvider);
  final allAgents = ref.watch(agentsProvider).agents;
  if (ids.isEmpty || allAgents.isEmpty) return [];

  final agentMap = {for (final a in allAgents) a.id: a};
  return ids
      .where((id) => agentMap.containsKey(id))
      .map((id) => agentMap[id]!)
      .toList();
});

// ---------- Find single agent ----------

final agentByIdProvider = Provider.family<Agent?, String>((ref, id) {
  final agents = ref.watch(agentsProvider).agents;
  try {
    return agents.firstWhere((a) => a.id == id);
  } catch (_) {
    return null;
  }
});

// ---------- State & notifiers ----------

class AgentsState {
  final List<Agent> agents;
  final bool isLoading;
  final String? error;

  const AgentsState({
    this.agents = const [],
    this.isLoading = false,
    this.error,
  });

  AgentsState copyWith({
    List<Agent>? agents,
    bool? isLoading,
    String? error,
  }) {
    return AgentsState(
      agents: agents ?? this.agents,
      isLoading: isLoading ?? this.isLoading,
      error: error,
    );
  }
}

class AgentsNotifier extends StateNotifier<AgentsState> {
  final dynamic _api;
  Timer? _activityTimer;

  AgentsNotifier(this._api) : super(const AgentsState()) {
    // Start periodic activity status polling (every 5 seconds)
    _activityTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _pollActivityStatuses(),
    );
  }

  @override
  void dispose() {
    _activityTimer?.cancel();
    super.dispose();
  }

  Future<void> fetchAgents() async {
    if (_api == null) return;

    state = state.copyWith(isLoading: true, error: null);

    try {
      final response = await _api.get(ApiEndpoints.agents);
      final List<dynamic> agentsList;

      if (response is List) {
        agentsList = response;
      } else if (response is Map && response['data'] is List) {
        agentsList = response['data'] as List;
      } else if (response is Map && response['agents'] is List) {
        agentsList = response['agents'] as List;
      } else {
        agentsList = [];
      }

      final agents = agentsList
          .whereType<Map<String, dynamic>>()
          .map((json) => Agent.fromJson(json))
          .toList();

      state = AgentsState(agents: agents);
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }

  /// Poll activity status for all active agents.
  Future<void> _pollActivityStatuses() async {
    if (_api == null || state.agents.isEmpty) return;

    bool changed = false;
    final updatedAgents = <Agent>[];

    for (final agent in state.agents) {
      if (!agent.isActive) {
        updatedAgents.add(agent);
        continue;
      }
      try {
        final response = await _api.get(ApiEndpoints.agentActivity(agent.id));
        if (response is Map) {
          final status = response['status']?.toString() ?? 'idle';
          if (agent.activityStatus != status) {
            updatedAgents.add(agent.copyWith(activityStatus: status));
            changed = true;
          } else {
            updatedAgents.add(agent);
          }
        } else {
          updatedAgents.add(agent);
        }
      } catch (_) {
        updatedAgents.add(agent);
      }
    }

    if (changed && mounted) {
      state = state.copyWith(agents: updatedAgents);
    }
  }

  Future<void> createAgent({
    required String id,
    String? telegramAccount,
    required String model,
    String? workspace,
  }) async {
    if (_api == null) return;

    final body = <String, dynamic>{
      'id': id,
      'model': model,
      if (telegramAccount != null && telegramAccount.isNotEmpty)
        'telegramAccount': telegramAccount,
      if (workspace != null && workspace.isNotEmpty) 'workspace': workspace,
    };

    await _api.post(ApiEndpoints.createAgent, body);
    await fetchAgents();
  }

  Future<void> deleteAgent(String id) async {
    if (_api == null) return;

    await _api.delete(ApiEndpoints.deleteAgent(id));
    await fetchAgents();
  }
}

class RecentAgentsNotifier extends StateNotifier<List<String>> {
  final SecureStorageService _storage;

  RecentAgentsNotifier(this._storage) : super([]) {
    _load();
  }

  Future<void> _load() async {
    state = await _storage.getRecentAgents();
  }

  Future<void> add(String agentId) async {
    await _storage.addRecentAgent(agentId);
    state = await _storage.getRecentAgents();
  }
}
