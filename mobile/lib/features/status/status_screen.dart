import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/status/status_provider.dart';
import 'package:tamerclaw_mobile/shared/models/system_status.dart';

class StatusScreen extends ConsumerWidget {
  const StatusScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(statusProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('System Status'),
      ),
      body: _buildBody(context, ref, state),
    );
  }

  Widget _buildBody(BuildContext context, WidgetRef ref, StatusState state) {
    if (state.isLoading && state.status == null) {
      return const Center(child: CircularProgressIndicator());
    }

    if (state.error != null && state.status == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.error, size: 48),
              const SizedBox(height: 16),
              Text(
                state.error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.textSecondary),
              ),
              const SizedBox(height: 16),
              TextButton(
                onPressed: () =>
                    ref.read(statusProvider.notifier).fetchAll(),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () => ref.read(statusProvider.notifier).fetchAll(),
      color: AppColors.accent,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Server health card
          if (state.status != null) _SystemHealthCard(status: state.status!),
          const SizedBox(height: 16),

          // Agent overview card
          if (state.status != null) _AgentOverviewCard(status: state.status!),
          const SizedBox(height: 16),

          // Delivery queue card
          _DeliveryCard(
            status: state.status,
            items: state.deliveryItems,
          ),
          const SizedBox(height: 16),

          // Cron jobs summary card
          _CronSummaryCard(
            jobs: state.cronJobs,
            onViewAll: () => context.push('/cron-jobs'),
          ),

          const SizedBox(height: 16),

          // Auto-refresh note
          Center(
            child: Text(
              'Auto-refreshes every 30s',
              style: TextStyle(
                color: AppColors.textSecondary.withOpacity(0.5),
                fontSize: 11,
              ),
            ),
          ),
          const SizedBox(height: 32),
        ],
      ),
    );
  }
}

// ---------- System Health ----------

class _SystemHealthCard extends StatelessWidget {
  final SystemStatus status;

  const _SystemHealthCard({required this.status});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.monitor_heart_outlined,
                    color: AppColors.online, size: 20),
                const SizedBox(width: 8),
                const Text(
                  'Server Health',
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: AppColors.online.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: const Text(
                    'Online',
                    style: TextStyle(
                      color: AppColors.online,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                _StatItem(
                  icon: Icons.timer_outlined,
                  label: 'Uptime',
                  value: status.uptime > 0 ? status.uptimeDisplay : '--',
                ),
                _StatItem(
                  icon: Icons.memory,
                  label: 'Sessions',
                  value: '${status.totalSessions}',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

// ---------- Agent Overview ----------

class _AgentOverviewCard extends StatelessWidget {
  final SystemStatus status;

  const _AgentOverviewCard({required this.status});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                Icon(Icons.smart_toy_outlined,
                    color: AppColors.accent, size: 20),
                SizedBox(width: 8),
                Text(
                  'Agent Overview',
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            // Progress bar
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: status.totalAgents > 0
                    ? status.activeAgents / status.totalAgents
                    : 0,
                backgroundColor: AppColors.surfaceLight,
                color: AppColors.online,
                minHeight: 8,
              ),
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  '${status.activeAgents} active',
                  style: const TextStyle(
                    color: AppColors.online,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  '${status.totalAgents} total',
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 14,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

// ---------- Delivery Queue ----------

class _DeliveryCard extends StatelessWidget {
  final SystemStatus? status;
  final List<DeliveryItem> items;

  const _DeliveryCard({required this.status, required this.items});

  @override
  Widget build(BuildContext context) {
    final pending = status?.deliveryPending ?? 0;
    final failed = status?.deliveryFailed ?? 0;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.outbox_outlined,
                  color: pending > 0 ? AppColors.warning : AppColors.textSecondary,
                  size: 20,
                ),
                const SizedBox(width: 8),
                const Text(
                  'Delivery Queue',
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                _MiniStat(
                  label: 'Pending',
                  value: '$pending',
                  color: pending > 0 ? AppColors.warning : AppColors.textSecondary,
                ),
                const SizedBox(width: 24),
                _MiniStat(
                  label: 'Failed',
                  value: '$failed',
                  color: failed > 0 ? AppColors.error : AppColors.textSecondary,
                ),
              ],
            ),
            if (failed > 0) ...[
              const SizedBox(height: 12),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: AppColors.error.withOpacity(0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.warning_amber,
                        color: AppColors.error, size: 16),
                    const SizedBox(width: 6),
                    Text(
                      '$failed failed deliveries need attention',
                      style:
                          const TextStyle(color: AppColors.error, fontSize: 12),
                    ),
                  ],
                ),
              ),
            ],
            if (pending == 0 && failed == 0) ...[
              const SizedBox(height: 8),
              const Text(
                'Queue is empty -- all deliveries processed',
                style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// ---------- Cron summary ----------

class _CronSummaryCard extends StatelessWidget {
  final List jobs;
  final VoidCallback onViewAll;

  const _CronSummaryCard({required this.jobs, required this.onViewAll});

  @override
  Widget build(BuildContext context) {
    final activeCount = jobs.where((j) => j.enabled).length;

    return Card(
      child: InkWell(
        onTap: onViewAll,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Row(
                children: [
                  Icon(Icons.schedule, color: AppColors.accent, size: 20),
                  SizedBox(width: 8),
                  Text(
                    'Cron Jobs',
                    style: TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Spacer(),
                  Icon(Icons.chevron_right,
                      color: AppColors.textSecondary, size: 20),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                '$activeCount active / ${jobs.length} total',
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 13,
                ),
              ),
              if (jobs.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(top: 4),
                  child: Text(
                    'No cron jobs configured',
                    style:
                        TextStyle(color: AppColors.textSecondary, fontSize: 12),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------- Shared widgets ----------

class _StatItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _StatItem({
    required this.icon,
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Row(
        children: [
          Icon(icon, color: AppColors.textSecondary, size: 16),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                value,
                style: const TextStyle(
                  color: AppColors.accent,
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                ),
              ),
              Text(
                label,
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 11,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _MiniStat extends StatelessWidget {
  final String label;
  final String value;
  final Color color;

  const _MiniStat({
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          style: TextStyle(
            color: color,
            fontSize: 22,
            fontWeight: FontWeight.w700,
          ),
        ),
        Text(
          label,
          style: const TextStyle(
            color: AppColors.textSecondary,
            fontSize: 11,
          ),
        ),
      ],
    );
  }
}
