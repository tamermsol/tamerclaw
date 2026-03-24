import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tamerclaw_mobile/shared/models/agent_customization.dart';

const _storageKey = 'agent_customizations';

final sharedPreferencesProvider = Provider<SharedPreferences>((ref) {
  throw UnimplementedError('Must be overridden in ProviderScope');
});

final agentCustomizationProvider = StateNotifierProvider<
    AgentCustomizationNotifier, Map<String, AgentCustomization>>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return AgentCustomizationNotifier(prefs);
});

/// Returns the customization for a single agent (or a default).
final agentCustomizationByIdProvider =
    Provider.family<AgentCustomization, String>((ref, agentId) {
  final all = ref.watch(agentCustomizationProvider);
  return all[agentId] ?? const AgentCustomization();
});

/// Returns an ordered list of favorite agent IDs.
final favoriteAgentIdsProvider = Provider<Set<String>>((ref) {
  final all = ref.watch(agentCustomizationProvider);
  return all.entries
      .where((e) => e.value.isFavorite)
      .map((e) => e.key)
      .toSet();
});

class AgentCustomizationNotifier
    extends StateNotifier<Map<String, AgentCustomization>> {
  final SharedPreferences _prefs;

  AgentCustomizationNotifier(this._prefs)
      : super(_loadFromPrefs(_prefs));

  static Map<String, AgentCustomization> _loadFromPrefs(
      SharedPreferences prefs) {
    final raw = prefs.getString(_storageKey);
    if (raw == null) return {};
    return AgentCustomization.decodeMap(raw);
  }

  Future<void> _persist() async {
    await _prefs.setString(
        _storageKey, AgentCustomization.encodeMap(state));
  }

  AgentCustomization _getOrCreate(String agentId) {
    return state[agentId] ?? const AgentCustomization();
  }

  Future<void> toggleFavorite(String agentId) async {
    final current = _getOrCreate(agentId);
    state = {
      ...state,
      agentId: current.copyWith(isFavorite: !current.isFavorite),
    };
    await _persist();
  }

  Future<void> setCustomName(String agentId, String? name) async {
    final current = _getOrCreate(agentId);
    state = {
      ...state,
      agentId: name != null && name.isNotEmpty
          ? current.copyWith(customName: name)
          : current.copyWith(clearCustomName: true),
    };
    await _persist();
  }

  Future<void> setCustomIcon(
      String agentId, IconData? icon) async {
    final current = _getOrCreate(agentId);
    if (icon == null) {
      state = {
        ...state,
        agentId: current.copyWith(clearIcon: true),
      };
    } else {
      state = {
        ...state,
        agentId: current.copyWith(
          iconCodePoint: icon.codePoint,
          iconFontFamily: icon.fontFamily,
        ),
      };
    }
    await _persist();
  }
}
