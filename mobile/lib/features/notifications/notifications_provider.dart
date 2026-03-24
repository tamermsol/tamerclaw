import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tamerclaw_mobile/features/agents/agents_provider.dart';
import 'package:tamerclaw_mobile/features/status/status_provider.dart';

final notificationsProvider =
    StateNotifierProvider<NotificationsNotifier, NotificationsState>((ref) {
  final notifier = NotificationsNotifier();

  // Generate notifications from agent/system state changes
  final agentsState = ref.watch(agentsProvider);
  final statusState = ref.watch(statusProvider);

  final notifications = <AppNotification>[];

  // Agent offline notifications
  for (final agent in agentsState.agents) {
    if (!agent.isActive) {
      notifications.add(AppNotification(
        id: 'agent_offline_${agent.id}',
        title: '${agent.displayName} is offline',
        body: 'Agent has gone inactive.',
        type: NotificationType.agentOffline,
        timestamp: agent.lastActivity ?? DateTime.now(),
        agentId: agent.id,
      ));
    }
  }

  // Delivery failures
  final deliveryFailed = statusState.status?.deliveryFailed ?? 0;
  if (deliveryFailed > 0) {
    notifications.add(AppNotification(
      id: 'delivery_failures',
      title: 'Delivery Queue Failures',
      body: '$deliveryFailed messages failed to deliver.',
      type: NotificationType.deliveryFailure,
      timestamp: DateTime.now(),
    ));
  }

  // Cron job errors (if any have not run recently)
  for (final job in statusState.cronJobs) {
    if (job.enabled && job.lastRun == null) {
      notifications.add(AppNotification(
        id: 'cron_never_run_${job.id}',
        title: 'Cron job "${job.name}" never ran',
        body: 'Scheduled as ${job.humanSchedule} but has never executed.',
        type: NotificationType.cronJobFailed,
        timestamp: DateTime.now(),
        agentId: job.agentId,
      ));
    }
  }

  // Connection error
  if (statusState.error != null) {
    notifications.add(AppNotification(
      id: 'system_error',
      title: 'System Error',
      body: statusState.error!,
      type: NotificationType.systemError,
      timestamp: DateTime.now(),
    ));
  }

  // Sort by timestamp descending
  notifications.sort((a, b) => b.timestamp.compareTo(a.timestamp));

  notifier.setNotifications(notifications);
  return notifier;
});

final unreadNotificationCountProvider = Provider<int>((ref) {
  final state = ref.watch(notificationsProvider);
  return state.notifications.where((n) => !n.isRead).length;
});

enum NotificationType {
  agentOffline,
  deliveryFailure,
  cronJobFailed,
  systemError,
}

class AppNotification {
  final String id;
  final String title;
  final String body;
  final NotificationType type;
  final DateTime timestamp;
  final String? agentId;
  final bool isRead;

  const AppNotification({
    required this.id,
    required this.title,
    required this.body,
    required this.type,
    required this.timestamp,
    this.agentId,
    this.isRead = false,
  });

  AppNotification copyWith({bool? isRead}) {
    return AppNotification(
      id: id,
      title: title,
      body: body,
      type: type,
      timestamp: timestamp,
      agentId: agentId,
      isRead: isRead ?? this.isRead,
    );
  }
}

class NotificationsState {
  final List<AppNotification> notifications;

  const NotificationsState({this.notifications = const []});

  NotificationsState copyWith({List<AppNotification>? notifications}) {
    return NotificationsState(
      notifications: notifications ?? this.notifications,
    );
  }
}

class NotificationsNotifier extends StateNotifier<NotificationsState> {
  final Set<String> _readIds = {};

  NotificationsNotifier() : super(const NotificationsState());

  void setNotifications(List<AppNotification> notifications) {
    final updated = notifications.map((n) {
      if (_readIds.contains(n.id)) {
        return n.copyWith(isRead: true);
      }
      return n;
    }).toList();
    state = NotificationsState(notifications: updated);
  }

  void markAsRead(String id) {
    _readIds.add(id);
    final updated = state.notifications.map((n) {
      if (n.id == id) return n.copyWith(isRead: true);
      return n;
    }).toList();
    state = NotificationsState(notifications: updated);
  }

  void markAllAsRead() {
    for (final n in state.notifications) {
      _readIds.add(n.id);
    }
    final updated = state.notifications
        .map((n) => n.copyWith(isRead: true))
        .toList();
    state = NotificationsState(notifications: updated);
  }
}
