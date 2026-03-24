import 'package:flutter/material.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';

class Agent {
  final String id;
  final String? telegramAccount;
  final String model;
  final bool isActive;
  final int sessions;
  final DateTime? lastActivity;
  final String? workspace;
  final bool hasToken;
  final String activityStatus; // idle, thinking, working, responding

  const Agent({
    required this.id,
    this.telegramAccount,
    this.model = 'unknown',
    this.isActive = false,
    this.sessions = 0,
    this.lastActivity,
    this.workspace,
    this.hasToken = false,
    this.activityStatus = 'idle',
  });

  factory Agent.fromJson(Map<String, dynamic> json) {
    return Agent(
      id: json['id'] as String? ?? 'unknown',
      telegramAccount: json['telegramAccount'] as String?,
      model: json['model'] as String? ?? 'unknown',
      isActive: json['isActive'] as bool? ?? false,
      sessions: json['sessions'] as int? ?? 0,
      lastActivity: json['lastActivity'] != null
          ? DateTime.tryParse(json['lastActivity'].toString())
          : null,
      workspace: json['workspace'] as String?,
      hasToken: json['hasToken'] as bool? ?? false,
      activityStatus: json['activityStatus'] as String? ?? 'idle',
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        if (telegramAccount != null) 'telegramAccount': telegramAccount,
        'model': model,
        if (workspace != null) 'workspace': workspace,
      };

  String get displayName {
    final name = telegramAccount ?? id;
    if (name.isEmpty) return id;
    return name.split('_').map((word) {
      if (word.isEmpty) return word;
      return word[0].toUpperCase() + word.substring(1);
    }).join(' ');
  }

  String get modelBadge {
    final lower = model.toLowerCase();
    if (lower.contains('opus')) return 'Opus';
    if (lower.contains('sonnet')) return 'Sonnet';
    if (lower.contains('haiku')) return 'Haiku';
    return model.length > 12 ? '${model.substring(0, 12)}...' : model;
  }

  Color get modelColor {
    final lower = model.toLowerCase();
    if (lower.contains('opus')) return AppColors.modelOpus;
    if (lower.contains('sonnet')) return AppColors.modelSonnet;
    if (lower.contains('haiku')) return AppColors.modelHaiku;
    return AppColors.textSecondary;
  }

  String get lastActivityText {
    if (lastActivity == null) return 'No activity';
    final diff = DateTime.now().difference(lastActivity!);
    if (diff.inSeconds < 60) return 'Just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    if (diff.inDays < 7) return '${diff.inDays}d ago';
    return '${diff.inDays}d ago';
  }

  /// Whether the agent is actively doing something (not idle).
  bool get isBusy => activityStatus != 'idle';

  /// Human-readable activity status label for the UI.
  String get activityStatusLabel {
    switch (activityStatus) {
      case 'thinking':
        return 'Thinking...';
      case 'working':
        return 'Working...';
      case 'responding':
        return 'Responding...';
      default:
        return '';
    }
  }

  /// Color for the activity status dot.
  Color get activityColor {
    switch (activityStatus) {
      case 'thinking':
        return const Color(0xFFFFA726); // orange
      case 'working':
        return const Color(0xFF42A5F5); // blue
      case 'responding':
        return const Color(0xFF66BB6A); // green
      default:
        return Colors.transparent;
    }
  }

  /// Copy with updated fields (useful for status updates).
  Agent copyWith({
    String? id,
    String? telegramAccount,
    String? model,
    bool? isActive,
    int? sessions,
    DateTime? lastActivity,
    String? workspace,
    bool? hasToken,
    String? activityStatus,
  }) {
    return Agent(
      id: id ?? this.id,
      telegramAccount: telegramAccount ?? this.telegramAccount,
      model: model ?? this.model,
      isActive: isActive ?? this.isActive,
      sessions: sessions ?? this.sessions,
      lastActivity: lastActivity ?? this.lastActivity,
      workspace: workspace ?? this.workspace,
      hasToken: hasToken ?? this.hasToken,
      activityStatus: activityStatus ?? this.activityStatus,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) || other is Agent && id == other.id;

  @override
  int get hashCode => id.hashCode;
}
