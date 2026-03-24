class SystemStatus {
  final int activeAgents;
  final int totalAgents;
  final int totalSessions;
  final int cronJobCount;
  final int deliveryPending;
  final int deliveryFailed;
  final int uptime;

  const SystemStatus({
    this.activeAgents = 0,
    this.totalAgents = 0,
    this.totalSessions = 0,
    this.cronJobCount = 0,
    this.deliveryPending = 0,
    this.deliveryFailed = 0,
    this.uptime = 0,
  });

  factory SystemStatus.fromStatusJson(Map<String, dynamic> json) {
    final bots = json['bots'] as Map<String, dynamic>? ?? {};
    final cron = json['cron'] as Map<String, dynamic>? ?? {};
    final delivery = json['delivery'] as Map<String, dynamic>? ?? {};

    // Backend returns bots as { active, total, sessions, statuses: { ... } }
    int active = bots['active'] as int? ?? 0;
    int total = bots['total'] as int? ?? 0;
    int sessionCount = bots['sessions'] as int? ?? 0;

    // Fallback: if bots is a flat map of agent statuses (legacy format),
    // aggregate from per-agent data
    if (active == 0 && total == 0 && bots['statuses'] == null) {
      for (final entry in bots.entries) {
        if (entry.value is Map<String, dynamic>) {
          total++;
          final bot = entry.value as Map<String, dynamic>;
          if (bot['active'] == true) active++;
          sessionCount += (bot['sessions'] as int?) ?? 0;
        }
      }
    }

    return SystemStatus(
      activeAgents: active,
      totalAgents: total,
      totalSessions: sessionCount,
      cronJobCount: cron['jobCount'] as int? ?? cron['jobs'] as int? ?? 0,
      deliveryPending: delivery['pending'] as int? ?? 0,
      deliveryFailed: delivery['failed'] as int? ?? 0,
    );
  }

  SystemStatus withUptime(int uptimeSeconds) {
    return SystemStatus(
      activeAgents: activeAgents,
      totalAgents: totalAgents,
      totalSessions: totalSessions,
      cronJobCount: cronJobCount,
      deliveryPending: deliveryPending,
      deliveryFailed: deliveryFailed,
      uptime: uptimeSeconds,
    );
  }

  String get uptimeDisplay {
    final days = uptime ~/ 86400;
    final hours = (uptime % 86400) ~/ 3600;
    final minutes = (uptime % 3600) ~/ 60;

    if (days > 0) return '${days}d ${hours}h ${minutes}m';
    if (hours > 0) return '${hours}h ${minutes}m';
    return '${minutes}m';
  }
}

class DeliveryItem {
  final String id;
  final String agentId;
  final String message;
  final int attempts;
  final int maxRetries;
  final String? lastError;

  const DeliveryItem({
    required this.id,
    required this.agentId,
    required this.message,
    this.attempts = 0,
    this.maxRetries = 3,
    this.lastError,
  });

  factory DeliveryItem.fromJson(Map<String, dynamic> json) {
    return DeliveryItem(
      id: json['id'] as String? ?? '',
      agentId: json['agentId'] as String? ?? '',
      message: json['message'] as String? ?? '',
      attempts: json['attempts'] as int? ?? 0,
      maxRetries: json['maxRetries'] as int? ?? 3,
      lastError: json['lastError'] as String?,
    );
  }
}
