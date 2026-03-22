class CronJob {
  final String id;
  final String agentId;
  final String name;
  final String schedule;
  final String? message;
  final String? command;
  final DateTime? lastRun;
  final DateTime? nextRun;
  final bool enabled;
  final String source; // 'managed' or 'system'

  const CronJob({
    required this.id,
    required this.agentId,
    required this.name,
    required this.schedule,
    this.message,
    this.command,
    this.lastRun,
    this.nextRun,
    this.enabled = true,
    this.source = 'managed',
  });

  bool get isSystem => source == 'system';
  bool get isManaged => source == 'managed';

  factory CronJob.fromJson(Map<String, dynamic> json) {
    // Handle schedule as either string or object
    String schedule;
    final rawSchedule = json['schedule'];
    if (rawSchedule is String) {
      schedule = rawSchedule;
    } else if (rawSchedule is Map) {
      schedule = (rawSchedule['cron'] ?? rawSchedule['at'] ?? '').toString();
    } else {
      schedule = '';
    }

    return CronJob(
      id: json['id'] as String? ?? '',
      agentId: json['agentId'] as String? ?? '',
      name: json['name'] as String? ?? 'Unnamed Job',
      schedule: schedule,
      message: json['message'] as String?,
      command: json['command'] as String?,
      lastRun: json['lastRun'] != null
          ? DateTime.tryParse(json['lastRun'].toString())
          : null,
      nextRun: json['nextRun'] != null
          ? DateTime.tryParse(json['nextRun'].toString())
          : null,
      enabled: json['enabled'] as bool? ?? true,
      source: (json['system'] == true) ? 'system' : (json['source'] as String? ?? 'managed'),
    );
  }

  Map<String, dynamic> toJson() => {
        'agentId': agentId,
        'name': name,
        'schedule': schedule,
        if (message != null) 'message': message,
        'enabled': enabled,
      };

  String get humanSchedule {
    final parts = schedule.split(' ');
    if (parts.length < 5) return schedule;

    if (schedule == '* * * * *') return 'Every minute';
    if (schedule == '0 * * * *') return 'Every hour';
    if (schedule == '0 0 * * *') return 'Daily at midnight';

    if (parts[0] != '*' && parts[1] != '*' && parts[2] == '*') {
      return 'Daily at ${parts[1].padLeft(2, '0')}:${parts[0].padLeft(2, '0')}';
    }
    if (parts[0].startsWith('*/')) {
      return 'Every ${parts[0].substring(2)} min';
    }
    if (parts[1].startsWith('*/')) {
      return 'Every ${parts[1].substring(2)} hours';
    }
    // Handle "7 * * * *" format (at minute 7 of every hour)
    if (parts[0] != '*' && parts[1] == '*' && parts[2] == '*') {
      return 'Hourly at :${parts[0].padLeft(2, '0')}';
    }
    return schedule;
  }

  String get lastRunText {
    if (lastRun == null) return 'Never';
    final diff = DateTime.now().difference(lastRun!);
    if (diff.inSeconds < 60) return 'Just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }
}
