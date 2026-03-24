import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:workmanager/workmanager.dart';

/// SharedPreferences keys used to pass credentials to the background isolate.
/// These mirror the values stored in secure storage but are accessible without
/// the main isolate's Flutter engine.
const _prefKeyServerUrl = 'bg_server_url';
const _prefKeyToken = 'bg_auth_token';

/// Unique name for the periodic background poll task.
const backgroundPollTaskName = 'com.tamerclaw.backgroundPoll';
const _backgroundPollTaskTag = 'backgroundPollTag';

/// Top-level callback dispatcher required by Workmanager.
///
/// This function runs in a separate isolate, so it cannot access Riverpod
/// providers or any state from the main isolate.
@pragma('vm:entry-point')
void callbackDispatcher() {
  Workmanager().executeTask((taskName, inputData) async {
    debugPrint('[BackgroundPoll] Task started: $taskName');

    try {
      final prefs = await SharedPreferences.getInstance();
      final serverUrl = prefs.getString(_prefKeyServerUrl);
      final token = prefs.getString(_prefKeyToken);

      if (serverUrl == null || token == null) {
        debugPrint('[BackgroundPoll] No credentials found, skipping');
        return true;
      }

      final cleanUrl = serverUrl.endsWith('/')
          ? serverUrl.substring(0, serverUrl.length - 1)
          : serverUrl;

      final headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      };

      // 1. Fetch system status to discover active agents.
      final statusResponse = await http
          .get(Uri.parse('$cleanUrl/api/status'), headers: headers)
          .timeout(const Duration(seconds: 10));

      if (statusResponse.statusCode == 401) {
        debugPrint('[BackgroundPoll] Token expired, skipping');
        return true;
      }

      if (statusResponse.statusCode != 200) {
        debugPrint(
            '[BackgroundPoll] Status request failed: ${statusResponse.statusCode}');
        return true;
      }

      final statusBody = jsonDecode(statusResponse.body);
      final List<dynamic> agents = statusBody['agents'] ?? [];

      if (agents.isEmpty) {
        debugPrint('[BackgroundPoll] No agents found');
        return true;
      }

      // 2. Check each agent for recent activity / unread messages.
      final plugin = FlutterLocalNotificationsPlugin();
      const androidSettings =
          AndroidInitializationSettings('@mipmap/ic_launcher');
      const initSettings = InitializationSettings(android: androidSettings);
      await plugin.initialize(initSettings);

      for (final agent in agents) {
        final agentId = agent['id']?.toString();
        final agentName = agent['name']?.toString() ?? agentId ?? 'Agent';
        if (agentId == null) continue;

        try {
          final activityResponse = await http
              .get(
                Uri.parse('$cleanUrl/api/agents/$agentId/activity'),
                headers: headers,
              )
              .timeout(const Duration(seconds: 10));

          if (activityResponse.statusCode != 200) continue;

          final activityBody = jsonDecode(activityResponse.body);
          final bool hasUnread = activityBody['hasUnread'] == true ||
              activityBody['has_unread'] == true;

          if (!hasUnread) continue;

          // Extract the latest message preview if available.
          final String preview =
              activityBody['latestMessage']?.toString() ??
                  activityBody['latest_message']?.toString() ??
                  'New message from $agentName';

          final truncated = preview.length > 200
              ? '${preview.substring(0, 200)}...'
              : preview;

          final androidDetails = AndroidNotificationDetails(
            'agent_messages',
            'Agent Messages',
            channelDescription:
                'Notifications when agents send messages',
            importance: Importance.high,
            priority: Priority.high,
            playSound: true,
            enableVibration: true,
            showWhen: true,
            groupKey: 'agent_$agentId',
            styleInformation: BigTextStyleInformation(truncated),
          );

          final details = NotificationDetails(android: androidDetails);
          final notificationId =
              agentId.hashCode % 2147483647;

          await plugin.show(
            notificationId,
            agentName,
            truncated,
            details,
            payload: agentId,
          );

          debugPrint(
              '[BackgroundPoll] Notification shown for agent $agentId');
        } catch (e) {
          debugPrint(
              '[BackgroundPoll] Error checking agent $agentId: $e');
        }
      }

      debugPrint('[BackgroundPoll] Task completed successfully');
      return true;
    } on SocketException {
      debugPrint('[BackgroundPoll] Network unavailable, will retry next cycle');
      return true;
    } catch (e) {
      debugPrint('[BackgroundPoll] Task failed: $e');
      return true; // Return true to avoid rescheduling on failure
    }
  });
}

/// Helper class to initialize and manage background polling registration.
class BackgroundPollService {
  BackgroundPollService._();

  /// Initialize the Workmanager plugin. Call once from main() before runApp().
  static Future<void> initialize() async {
    await Workmanager().initialize(
      callbackDispatcher,
      isInDebugMode: kDebugMode,
    );
  }

  /// Register the periodic background poll task.
  ///
  /// On Android, the minimum interval enforced by WorkManager is 15 minutes.
  static Future<void> registerPeriodicTask() async {
    await Workmanager().registerPeriodicTask(
      backgroundPollTaskName,
      backgroundPollTaskName,
      tag: _backgroundPollTaskTag,
      frequency: const Duration(minutes: 15),
      constraints: Constraints(
        networkType: NetworkType.connected,
      ),
      existingWorkPolicy: ExistingWorkPolicy.replace,
      backoffPolicy: BackoffPolicy.linear,
      backoffPolicyDelay: const Duration(minutes: 1),
    );
    debugPrint('[BackgroundPoll] Periodic task registered');
  }

  /// Cancel all background poll tasks (e.g. on logout).
  static Future<void> cancelAll() async {
    await Workmanager().cancelByTag(_backgroundPollTaskTag);
    debugPrint('[BackgroundPoll] All tasks cancelled');
  }

  /// Save credentials to SharedPreferences so the background isolate can
  /// access them. Call this whenever login succeeds or token refreshes.
  static Future<void> saveCredentialsForBackground({
    required String serverUrl,
    required String token,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefKeyServerUrl, serverUrl);
    await prefs.setString(_prefKeyToken, token);
    debugPrint('[BackgroundPoll] Credentials saved for background polling');
  }

  /// Clear background credentials (e.g. on logout).
  static Future<void> clearCredentials() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_prefKeyServerUrl);
    await prefs.remove(_prefKeyToken);
  }
}
