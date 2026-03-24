import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tamerclaw_mobile/features/agents/agents_provider.dart';
import 'package:tamerclaw_mobile/features/status/status_provider.dart';
import 'package:tamerclaw_mobile/shared/models/agent.dart';

// Dashboard aggregates data from existing providers

final dashboardMetricsProvider = Provider<DashboardMetrics>((ref) {
  final statusState = ref.watch(statusProvider);
  final agentsState = ref.watch(agentsProvider);
  final status = statusState.status;

  return DashboardMetrics(
    activeAgents: status?.activeAgents ?? 0,
    totalAgents: status?.totalAgents ?? agentsState.agents.length,
    totalSessions: status?.totalSessions ?? 0,
    uptime: status?.uptimeDisplay ?? '--',
    deliveryPending: status?.deliveryPending ?? 0,
    deliveryFailed: status?.deliveryFailed ?? 0,
    cronJobCount: status?.cronJobCount ?? 0,
    isLoading: statusState.isLoading || agentsState.isLoading,
    error: statusState.error ?? agentsState.error,
  );
});

final dashboardHealthProvider = Provider<SystemHealth>((ref) {
  final statusState = ref.watch(statusProvider);
  final agentsState = ref.watch(agentsProvider);
  final status = statusState.status;

  if (statusState.error != null || agentsState.error != null) {
    return SystemHealth.error;
  }
  if (status == null) return SystemHealth.unknown;
  if (status.deliveryFailed > 0) return SystemHealth.warning;
  if (status.activeAgents == 0 && status.totalAgents > 0) {
    return SystemHealth.warning;
  }
  return SystemHealth.healthy;
});

final dashboardAgentGridProvider = Provider<List<Agent>>((ref) {
  final agents = ref.watch(agentsProvider).agents;
  final sorted = List<Agent>.from(agents)
    ..sort((a, b) {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return a.displayName.compareTo(b.displayName);
    });
  return sorted;
});

/// Provides agent health distribution: [healthy, warning, error]
final agentHealthDistributionProvider = Provider<List<int>>((ref) {
  final agents = ref.watch(agentsProvider).agents;
  int healthy = 0;
  int warning = 0;
  int error = 0;

  for (final agent in agents) {
    if (agent.isActive) {
      healthy++;
    } else if (agent.lastActivity != null) {
      final diff = DateTime.now().difference(agent.lastActivity!);
      if (diff.inHours < 24) {
        warning++;
      } else {
        error++;
      }
    } else {
      error++;
    }
  }
  return [healthy, warning, error];
});

/// Recent messages placeholder - shows recent agent activity with pseudo data
final recentMessagesProvider = Provider<List<RecentMessage>>((ref) {
  final agents = ref.watch(agentsProvider).agents;
  final active = agents.where((a) => a.isActive).toList();
  if (active.isEmpty) return [];

  return active.take(5).map((agent) {
    return RecentMessage(
      agentId: agent.id,
      agentName: agent.displayName,
      preview: agent.isActive ? 'Active session in progress...' : 'Last session ended',
      timestamp: agent.lastActivity ?? DateTime.now(),
    );
  }).toList();
});

enum SystemHealth { healthy, warning, error, unknown }

class DashboardMetrics {
  final int activeAgents;
  final int totalAgents;
  final int totalSessions;
  final String uptime;
  final int deliveryPending;
  final int deliveryFailed;
  final int cronJobCount;
  final bool isLoading;
  final String? error;

  const DashboardMetrics({
    this.activeAgents = 0,
    this.totalAgents = 0,
    this.totalSessions = 0,
    this.uptime = '--',
    this.deliveryPending = 0,
    this.deliveryFailed = 0,
    this.cronJobCount = 0,
    this.isLoading = false,
    this.error,
  });
}

class RecentMessage {
  final String agentId;
  final String agentName;
  final String preview;
  final DateTime timestamp;

  const RecentMessage({
    required this.agentId,
    required this.agentName,
    required this.preview,
    required this.timestamp,
  });

  String get timeAgo {
    final diff = DateTime.now().difference(timestamp);
    if (diff.inSeconds < 60) return 'Just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }
}
