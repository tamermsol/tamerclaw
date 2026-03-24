import 'package:flutter_test/flutter_test.dart';

import 'package:tamerclaw_mobile/shared/models/agent.dart';
import 'package:tamerclaw_mobile/shared/models/message.dart';
import 'package:tamerclaw_mobile/shared/models/system_status.dart';
import 'package:tamerclaw_mobile/shared/models/cron_job.dart';

void main() {
  group('Agent model', () {
    test('fromJson parses correctly', () {
      final json = {
        'id': 'agent-1',
        'telegramAccount': 'supreme_agent',
        'model': 'claude-sonnet-4-20250514',
        'isActive': true,
        'sessions': 3,
        'lastActivity': '2026-03-21T10:00:00Z',
      };

      final agent = Agent.fromJson(json);

      expect(agent.id, 'agent-1');
      expect(agent.telegramAccount, 'supreme_agent');
      expect(agent.model, 'claude-sonnet-4-20250514');
      expect(agent.isActive, isTrue);
      expect(agent.sessions, 3);
      expect(agent.lastActivity, isNotNull);
    });

    test('handles missing fields gracefully', () {
      final agent = Agent.fromJson({'id': 'test'});

      expect(agent.id, 'test');
      expect(agent.isActive, isFalse);
      expect(agent.model, 'unknown');
      expect(agent.sessions, 0);
    });

    test('displayName capitalizes words', () {
      final agent = Agent.fromJson({
        'id': 'a1',
        'telegramAccount': 'supreme_agent',
      });
      expect(agent.displayName, 'Supreme Agent');
    });

    test('modelBadge identifies model types', () {
      expect(Agent.fromJson({'model': 'claude-opus-4-20250514'}).modelBadge, 'Opus');
      expect(Agent.fromJson({'model': 'claude-sonnet-4-20250514'}).modelBadge, 'Sonnet');
      expect(Agent.fromJson({'model': 'claude-haiku-3.5'}).modelBadge, 'Haiku');
    });
  });

  group('ChatMessage model', () {
    test('user message properties', () {
      final message = ChatMessage(
        id: '1',
        content: 'Hello world',
        isUser: true,
        timestamp: DateTime(2026, 3, 21),
      );

      expect(message.isUser, isTrue);
      expect(message.content, 'Hello world');
      expect(message.isLoading, isFalse);
      expect(message.isError, isFalse);
    });

    test('copyWith modifies correctly', () {
      final original = ChatMessage(
        id: '1',
        content: 'Loading...',
        isUser: false,
        timestamp: DateTime(2026, 3, 21),
        isLoading: true,
      );

      final updated = original.copyWith(content: 'Response text', isLoading: false);

      expect(updated.content, 'Response text');
      expect(updated.isLoading, isFalse);
      expect(updated.isUser, isFalse); // unchanged
    });
  });

  group('SystemStatus model', () {
    test('fromStatusJson parses correctly', () {
      final json = {
        'bots': {'active': 3, 'total': 5, 'sessions': 10},
        'cron': {'jobCount': 2},
        'delivery': {'pending': 1, 'failed': 0},
      };

      final status = SystemStatus.fromStatusJson(json);

      expect(status.activeAgents, 3);
      expect(status.totalAgents, 5);
      expect(status.totalSessions, 10);
      expect(status.cronJobCount, 2);
      expect(status.deliveryPending, 1);
      expect(status.deliveryFailed, 0);
    });

    test('uptime display formatting', () {
      const status1 = SystemStatus(uptime: 180000); // 2d 2h
      expect(status1.uptimeDisplay, contains('d'));

      const status2 = SystemStatus(uptime: 3900); // 1h 5m
      expect(status2.uptimeDisplay, '1h 5m');

      const status3 = SystemStatus(uptime: 300); // 5m
      expect(status3.uptimeDisplay, '5m');
    });

    test('withUptime merges uptime', () {
      const status = SystemStatus(activeAgents: 3, totalAgents: 5);
      final withUptime = status.withUptime(86400);

      expect(withUptime.uptime, 86400);
      expect(withUptime.activeAgents, 3); // preserved
    });
  });

  group('CronJob model', () {
    test('fromJson parses correctly', () {
      final json = {
        'id': 'cron-1',
        'agentId': 'agent-1',
        'name': 'Daily Report',
        'schedule': '0 0 * * *',
        'enabled': true,
      };

      final job = CronJob.fromJson(json);

      expect(job.id, 'cron-1');
      expect(job.name, 'Daily Report');
      expect(job.humanSchedule, 'Daily at midnight');
    });

    test('humanSchedule for common patterns', () {
      expect(CronJob.fromJson({'schedule': '* * * * *'}).humanSchedule, 'Every minute');
      expect(CronJob.fromJson({'schedule': '0 * * * *'}).humanSchedule, 'Every hour');
      expect(CronJob.fromJson({'schedule': '*/5 * * * *'}).humanSchedule, 'Every 5 min');
    });
  });

  group('DeliveryItem model', () {
    test('fromJson parses correctly', () {
      final json = {
        'id': 'del-1',
        'agentId': 'agent-1',
        'message': 'Hello',
        'attempts': 2,
        'maxRetries': 3,
        'lastError': 'timeout',
      };

      final item = DeliveryItem.fromJson(json);

      expect(item.id, 'del-1');
      expect(item.attempts, 2);
      expect(item.lastError, 'timeout');
    });
  });
}
