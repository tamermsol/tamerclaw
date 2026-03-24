import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/telegram/telegram_provider.dart';

class TelegramScreen extends ConsumerStatefulWidget {
  const TelegramScreen({super.key});

  @override
  ConsumerState<TelegramScreen> createState() => _TelegramScreenState();
}

class _TelegramScreenState extends ConsumerState<TelegramScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      ref.read(telegramBotsProvider.notifier).fetchTelegramConfig();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(telegramBotsProvider);
    final bots = state.bots;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Telegram Management'),
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          HapticFeedback.mediumImpact();
          await ref.read(telegramBotsProvider.notifier).fetchTelegramConfig();
        },
        color: AppColors.accent,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            // Relay bot status
            _RelayBotCard(isActive: state.relayBotActive),
            const SizedBox(height: 16),

            // Stats row
            _TelegramStats(bots: bots),
            const SizedBox(height: 20),

            // Bots list
            if (bots.isEmpty)
              _EmptyBotsState()
            else ...[
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(
                  'CONNECTED BOTS (${bots.length})',
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 1,
                  ),
                ),
              ),
              ...bots.map((bot) => _TelegramBotCard(bot: bot)),
            ],

            const SizedBox(height: 80),
          ],
        ),
      ),
    );
  }
}

class _RelayBotCard extends StatelessWidget {
  final bool isActive;

  const _RelayBotCard({required this.isActive});

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppColors.info.withOpacity(0.12),
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.share, color: AppColors.info, size: 22),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Relay Bot',
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  isActive
                      ? 'Active - routing messages between bots'
                      : 'Not configured',
                  style: TextStyle(
                    color: isActive ? AppColors.success : AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              color: isActive ? AppColors.online : AppColors.offline,
              shape: BoxShape.circle,
              boxShadow: isActive
                  ? [
                      BoxShadow(
                        color: AppColors.online.withOpacity(0.4),
                        blurRadius: 6,
                        spreadRadius: 1,
                      ),
                    ]
                  : null,
            ),
          ),
        ],
      ),
    );
  }
}

class _TelegramStats extends StatelessWidget {
  final List<TelegramBot> bots;

  const _TelegramStats({required this.bots});

  @override
  Widget build(BuildContext context) {
    final onlineCount = bots.where((b) => b.isOnline).length;
    final totalSessions =
        bots.fold<int>(0, (sum, b) => sum + b.sessions);

    return Row(
      children: [
        Expanded(
          child: _StatCard(
            label: 'Total Bots',
            value: '${bots.length}',
            icon: Icons.telegram,
            color: AppColors.info,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _StatCard(
            label: 'Online',
            value: '$onlineCount',
            icon: Icons.cloud_done,
            color: AppColors.success,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _StatCard(
            label: 'Sessions',
            value: '$totalSessions',
            icon: Icons.chat_bubble_outline,
            color: AppColors.accent,
          ),
        ),
      ],
    );
  }
}

class _StatCard extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;

  const _StatCard({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.surfaceLight, width: 1),
      ),
      child: Column(
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(height: 8),
          Text(
            value,
            style: TextStyle(
              color: color,
              fontSize: 18,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 10,
            ),
          ),
        ],
      ),
    );
  }
}

class _TelegramBotCard extends StatelessWidget {
  final TelegramBot bot;

  const _TelegramBotCard({required this.bot});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.surfaceLight, width: 1),
      ),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: AppColors.info.withOpacity(0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Center(
              child: Text(
                bot.displayName.isNotEmpty
                    ? bot.displayName[0].toUpperCase()
                    : '?',
                style: const TextStyle(
                  color: AppColors.info,
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  bot.displayName,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    if (bot.username != null) ...[
                      Text(
                        '@${bot.username}',
                        style: const TextStyle(
                          color: AppColors.info,
                          fontSize: 12,
                        ),
                      ),
                      const SizedBox(width: 10),
                    ],
                    Text(
                      '${bot.sessions} sessions',
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: bot.isOnline
                      ? AppColors.online.withOpacity(0.12)
                      : AppColors.offline.withOpacity(0.12),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  bot.isOnline ? 'Online' : 'Offline',
                  style: TextStyle(
                    color: bot.isOnline ? AppColors.online : AppColors.offline,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              const SizedBox(height: 6),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: bot.hasToken ? AppColors.online : AppColors.offline,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    bot.hasToken ? 'Token' : 'No token',
                    style: TextStyle(
                      color: bot.hasToken
                          ? AppColors.textSecondary
                          : AppColors.offline,
                      fontSize: 10,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _EmptyBotsState extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 40),
        child: Column(
          children: [
            Container(
              width: 80,
              height: 80,
              decoration: BoxDecoration(
                color: AppColors.surfaceLight.withOpacity(0.3),
                shape: BoxShape.circle,
              ),
              child: Icon(
                Icons.telegram,
                color: AppColors.textSecondary.withOpacity(0.4),
                size: 40,
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'No Telegram bots',
              style: TextStyle(
                color: AppColors.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 6),
            const Text(
              'Create an agent with a Telegram token to get started',
              style: TextStyle(
                color: AppColors.textSecondary,
                fontSize: 13,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
