import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:go_router/go_router.dart';
import 'package:tamerclaw_mobile/features/chat/chat_provider.dart';
import 'package:tamerclaw_mobile/shared/models/message.dart';

/// Manages local push notifications for agent messages.
///
/// Uses `flutter_local_notifications` to show OS-level notifications
/// when agent messages arrive (especially when app is in background).
///
/// Navigation on notification tap is handled two ways:
/// 1. If the GoRouter is available (app alive), navigate immediately.
/// 2. If the app was terminated, store the target and let the app
///    consume it on startup via [consumePendingNavigation].
class PushNotificationService {
  static final PushNotificationService _instance = PushNotificationService._();
  factory PushNotificationService() => _instance;
  PushNotificationService._();

  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  bool _initialized = false;
  bool _appInForeground = true;
  String? _activeAgentId;

  /// The app's router, set once the widget tree is built.
  GoRouter? _router;

  /// Provide the GoRouter instance so notification taps can navigate directly.
  void setRouter(GoRouter router) {
    _router = router;

    // If a notification was tapped before the router was ready (cold start),
    // navigate now.
    final pending = _pendingNavigation;
    if (pending != null) {
      _pendingNavigation = null;
      _navigateToChat(pending);
    }
  }

  /// Track which agent chat is currently visible.
  /// When set, notifications for this agent are fully suppressed.
  void setActiveAgentId(String? agentId) {
    _activeAgentId = agentId;
  }

  /// Initialize the notification plugin. Call once from main().
  Future<void> init() async {
    if (_initialized) return;

    const androidSettings = AndroidInitializationSettings('@mipmap/ic_launcher');
    const initSettings = InitializationSettings(android: androidSettings);

    await _plugin.initialize(
      initSettings,
      onDidReceiveNotificationResponse: _onNotificationTap,
    );

    // Request notification permission (Android 13+)
    if (Platform.isAndroid) {
      final androidPlugin = _plugin.resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
      await androidPlugin?.requestNotificationsPermission();
    }

    // Check if the app was launched by tapping a notification (cold start).
    final launchDetails = await _plugin.getNotificationAppLaunchDetails();
    if (launchDetails != null &&
        launchDetails.didNotificationLaunchApp &&
        launchDetails.notificationResponse != null) {
      final agentId = launchDetails.notificationResponse!.payload;
      if (agentId != null && agentId.isNotEmpty) {
        debugPrint('[PushNotificationService] App launched from notification for agent: $agentId');
        _pendingNavigation = agentId;
      }
    }

    // Wire into the chat provider's new-message callback
    onNewMessageReceived = _onNewAgentMessage;

    _initialized = true;
    debugPrint('[PushNotificationService] Initialized');
  }

  /// Track app lifecycle state.
  void setAppInForeground(bool foreground) {
    _appInForeground = foreground;
  }

  /// Called when a new agent message is received via polling.
  void _onNewAgentMessage(String agentId, ChatMessage message) {
    if (message.isUser) return;

    // Fully suppress notification if user is viewing this agent's chat
    if (_appInForeground && _activeAgentId == agentId) return;

    // Show notification — in background always, in foreground as subtle alert
    _showNotification(agentId, message, silent: _appInForeground);
  }

  /// Show a local push notification.
  Future<void> _showNotification(String agentId, ChatMessage message, {bool silent = false}) async {
    final content = message.content.length > 200
        ? '${message.content.substring(0, 200)}...'
        : message.content;

    final androidDetails = AndroidNotificationDetails(
      'agent_messages',
      'Agent Messages',
      channelDescription: 'Notifications when agents send messages',
      importance: silent ? Importance.defaultImportance : Importance.high,
      priority: silent ? Priority.defaultPriority : Priority.high,
      playSound: true,
      enableVibration: !silent,
      showWhen: true,
      groupKey: 'agent_$agentId',
      styleInformation: BigTextStyleInformation(content),
    );

    final details = NotificationDetails(android: androidDetails);

    // Use timestamp as unique ID
    final notificationId = message.timestamp.millisecondsSinceEpoch % 2147483647;

    await _plugin.show(
      notificationId,
      agentId, // Title is the agent name
      content,
      details,
      payload: agentId, // Used to navigate on tap
    );
  }

  /// Navigate to the agent's chat screen.
  void _navigateToChat(String agentId) {
    debugPrint('[PushNotificationService] Navigating to chat for agent: $agentId');
    _router?.push('/chat/$agentId');
  }

  /// Handle notification tap — navigate to agent chat.
  void _onNotificationTap(NotificationResponse response) {
    final agentId = response.payload;
    if (agentId == null || agentId.isEmpty) return;

    debugPrint('[PushNotificationService] Notification tapped for agent: $agentId');

    if (_router != null) {
      // Router is available — navigate immediately
      _navigateToChat(agentId);
    } else {
      // App may be initializing — store for later pickup
      _pendingNavigation = agentId;
    }
  }

  /// Pending navigation target from notification tap (cold start only).
  String? _pendingNavigation;

  /// Consume and return any pending navigation target.
  /// Called by the app shell on startup to handle cold-start notification taps.
  String? consumePendingNavigation() {
    final target = _pendingNavigation;
    _pendingNavigation = null;
    return target;
  }
}
