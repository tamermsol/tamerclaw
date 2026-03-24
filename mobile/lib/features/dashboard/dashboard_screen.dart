import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/agents/agents_provider.dart';
import 'package:tamerclaw_mobile/features/dashboard/dashboard_provider.dart';
import 'package:tamerclaw_mobile/features/notifications/notifications_provider.dart';
import 'package:tamerclaw_mobile/features/status/status_provider.dart';
import 'package:tamerclaw_mobile/shared/models/agent.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final metrics = ref.watch(dashboardMetricsProvider);
    final health = ref.watch(dashboardHealthProvider);
    final agents = ref.watch(dashboardAgentGridProvider);
    final recentAgents = ref.watch(recentAgentsProvider);
    final statusState = ref.watch(statusProvider);
    final unreadCount = ref.watch(unreadNotificationCountProvider);
    final healthDistribution = ref.watch(agentHealthDistributionProvider);
    final recentMessages = ref.watch(recentMessagesProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Command Center'),
        actions: [
          // Notification bell with badge
          Stack(
            alignment: Alignment.center,
            children: [
              IconButton(
                icon: const Icon(Icons.notifications_outlined),
                onPressed: () {
                  HapticFeedback.lightImpact();
                  context.push('/notifications');
                },
              ),
              if (unreadCount > 0)
                Positioned(
                  top: 8,
                  right: 8,
                  child: Container(
                    padding: const EdgeInsets.all(4),
                    decoration: const BoxDecoration(
                      color: AppColors.error,
                      shape: BoxShape.circle,
                    ),
                    constraints: const BoxConstraints(
                      minWidth: 18,
                      minHeight: 18,
                    ),
                    child: Text(
                      unreadCount > 99 ? '99+' : '$unreadCount',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                ),
            ],
          ),
          if (metrics.isLoading)
            const Padding(
              padding: EdgeInsets.only(right: 16),
              child: SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          HapticFeedback.mediumImpact();
          await Future.wait([
            ref.read(statusProvider.notifier).fetchAll(),
            ref.read(agentsProvider.notifier).fetchAgents(),
          ]);
        },
        color: AppColors.accent,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            // System health
            _SystemHealthBadge(health: health),
            const SizedBox(height: 16),

            // Hero metrics with animated counters
            _AnimatedMetricsRow(metrics: metrics),
            const SizedBox(height: 20),

            // System health ring chart + quick stats
            if (agents.isNotEmpty) ...[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Health ring chart
                  Expanded(
                    child: _HealthRingChart(
                      distribution: healthDistribution,
                      total: agents.length,
                    ),
                  ),
                  const SizedBox(width: 12),
                  // Quick stats column
                  Expanded(
                    child: _QuickStatsColumn(metrics: metrics),
                  ),
                ],
              ),
              const SizedBox(height: 20),
            ],

            // Quick actions (2x2 grid)
            _QuickActionsGrid(
              onNewChat: () => _showAgentPicker(context, ref, agents),
              onCreateAgent: () => context.push('/agents/create'),
              onAddCronJob: () => context.go('/cron'),
              onViewLogs: () => context.go('/settings'),
            ),
            const SizedBox(height: 20),

            // Recent messages section
            if (recentMessages.isNotEmpty) ...[
              const _SectionHeader(title: 'RECENT MESSAGES'),
              const SizedBox(height: 8),
              _RecentMessagesSection(messages: recentMessages),
              const SizedBox(height: 20),
            ],

            // Real-time activity timeline
            if (recentAgents.isNotEmpty) ...[
              const _SectionHeader(title: 'AGENT ACTIVITY TIMELINE'),
              const SizedBox(height: 8),
              _ActivityTimeline(agents: recentAgents.take(8).toList()),
              const SizedBox(height: 20),
            ],

            // System resources
            _SystemResourcesSection(
                metrics: metrics, statusState: statusState),
            const SizedBox(height: 20),

            // Agent health grid
            if (agents.isNotEmpty) ...[
              _SectionHeader(title: 'AGENT HEALTH (${agents.length})'),
              const SizedBox(height: 8),
              _AgentHealthGrid(agents: agents),
            ],

            const SizedBox(height: 80),
          ],
        ),
      ),
    );
  }

  void _showAgentPicker(
      BuildContext context, WidgetRef ref, List<Agent> agents) {
    if (agents.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No agents available')),
      );
      return;
    }

    HapticFeedback.lightImpact();
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (ctx) => _AgentPickerSheet(
        agents: agents,
        onSelect: (agent) {
          Navigator.pop(ctx);
          ref.read(recentAgentIdsProvider.notifier).add(agent.id);
          context.push('/chat/${agent.id}');
        },
      ),
    );
  }
}

// ---------- Agent Picker Bottom Sheet ----------

class _AgentPickerSheet extends StatelessWidget {
  final List<Agent> agents;
  final ValueChanged<Agent> onSelect;

  const _AgentPickerSheet({required this.agents, required this.onSelect});

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      initialChildSize: 0.5,
      maxChildSize: 0.8,
      minChildSize: 0.3,
      builder: (ctx, scrollController) {
        return Container(
          decoration: const BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
          ),
          child: Column(
            children: [
              const SizedBox(height: 8),
              Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: AppColors.surfaceLight,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text(
                  'Start Chat',
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Expanded(
                child: ListView.builder(
                  controller: scrollController,
                  itemCount: agents.length,
                  itemBuilder: (ctx, i) {
                    final agent = agents[i];
                    return ListTile(
                      leading: CircleAvatar(
                        radius: 18,
                        backgroundColor: agent.modelColor.withOpacity(0.15),
                        child: Text(
                          agent.displayName.isNotEmpty
                              ? agent.displayName[0]
                              : '?',
                          style: TextStyle(
                            color: agent.modelColor,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      title: Text(
                        agent.displayName,
                        style: const TextStyle(
                          color: AppColors.textPrimary,
                          fontSize: 14,
                        ),
                      ),
                      trailing: Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: agent.isActive
                              ? AppColors.online
                              : AppColors.offline,
                          shape: BoxShape.circle,
                        ),
                      ),
                      onTap: () => onSelect(agent),
                    );
                  },
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

// ---------- System Health Badge ----------

class _SystemHealthBadge extends StatefulWidget {
  final SystemHealth health;

  const _SystemHealthBadge({required this.health});

  @override
  State<_SystemHealthBadge> createState() => _SystemHealthBadgeState();
}

class _SystemHealthBadgeState extends State<_SystemHealthBadge>
    with SingleTickerProviderStateMixin {
  late AnimationController _glowController;

  @override
  void initState() {
    super.initState();
    _glowController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2000),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _glowController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Color color;
    final String label;
    final IconData icon;
    final String subtitle;

    switch (widget.health) {
      case SystemHealth.healthy:
        color = AppColors.success;
        label = 'All Systems Operational';
        icon = Icons.check_circle;
        subtitle = 'Running smoothly';
      case SystemHealth.warning:
        color = AppColors.warning;
        label = 'Attention Required';
        icon = Icons.warning_rounded;
        subtitle = 'Some issues detected';
      case SystemHealth.error:
        color = AppColors.error;
        label = 'System Error';
        icon = Icons.error;
        subtitle = 'Immediate attention needed';
      case SystemHealth.unknown:
        color = AppColors.textSecondary;
        label = 'Checking Status...';
        icon = Icons.hourglass_empty;
        subtitle = 'Connecting to server';
    }

    return AnimatedBuilder(
      animation: _glowController,
      builder: (context, _) {
        final glowOpacity = widget.health == SystemHealth.healthy
            ? 0.05 + _glowController.value * 0.08
            : 0.0;
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            color: color.withOpacity(0.08),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: color.withOpacity(0.25), width: 1),
            boxShadow: [
              if (widget.health == SystemHealth.healthy)
                BoxShadow(
                  color: color.withOpacity(glowOpacity),
                  blurRadius: 16,
                  spreadRadius: 0,
                ),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: color.withOpacity(0.12),
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, color: color, size: 20),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: TextStyle(
                        color: color,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(
                        color: color.withOpacity(0.7),
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ),
              // Animated pulse dot for healthy status
              if (widget.health == SystemHealth.healthy)
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: color.withOpacity(0.7 + _glowController.value * 0.3),
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(
                        color: color.withOpacity(0.3 * _glowController.value),
                        blurRadius: 8,
                        spreadRadius: 2,
                      ),
                    ],
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

// ---------- Animated Metrics Row ----------

class _AnimatedMetricsRow extends StatelessWidget {
  final DashboardMetrics metrics;

  const _AnimatedMetricsRow({required this.metrics});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(14),
        gradient: LinearGradient(
          colors: [
            AppColors.accent.withOpacity(0.15),
            AppColors.gradientEnd.withOpacity(0.08),
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: _AnimatedMetricCard(
              icon: Icons.smart_toy,
              label: 'Active',
              value: metrics.activeAgents,
              color: AppColors.success,
              showPulse: metrics.activeAgents > 0,
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: _AnimatedMetricCard(
              icon: Icons.chat_bubble_outline,
              label: 'Sessions',
              value: metrics.totalSessions,
              color: AppColors.accent,
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: _MetricCardText(
              icon: Icons.timer_outlined,
              label: 'Uptime',
              value: metrics.uptime,
              color: AppColors.info,
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: _AnimatedMetricCard(
              icon: Icons.outbox,
              label: 'Queue',
              value: metrics.deliveryPending,
              color: metrics.deliveryFailed > 0
                  ? AppColors.warning
                  : AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

class _AnimatedMetricCard extends StatefulWidget {
  final IconData icon;
  final String label;
  final int value;
  final Color color;
  final bool showPulse;

  const _AnimatedMetricCard({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
    this.showPulse = false,
  });

  @override
  State<_AnimatedMetricCard> createState() => _AnimatedMetricCardState();
}

class _AnimatedMetricCardState extends State<_AnimatedMetricCard>
    with SingleTickerProviderStateMixin {
  late AnimationController _pulseController;
  int _displayValue = 0;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    );
    if (widget.showPulse) {
      _pulseController.repeat(reverse: true);
    }
    _animateValue(0, widget.value);
  }

  @override
  void didUpdateWidget(covariant _AnimatedMetricCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.value != widget.value) {
      _animateValue(_displayValue, widget.value);
    }
    if (widget.showPulse && !_pulseController.isAnimating) {
      _pulseController.repeat(reverse: true);
    } else if (!widget.showPulse && _pulseController.isAnimating) {
      _pulseController.stop();
    }
  }

  void _animateValue(int from, int to) {
    final diff = (to - from).abs();
    if (diff == 0) {
      setState(() => _displayValue = to);
      return;
    }
    final steps = min(diff, 20);
    const duration = Duration(milliseconds: 600);
    final stepDuration = duration ~/ steps;

    for (int i = 1; i <= steps; i++) {
      Future.delayed(stepDuration * i, () {
        if (mounted) {
          setState(() {
            _displayValue = from + ((to - from) * i / steps).round();
          });
        }
      });
    }
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _pulseController,
      builder: (context, child) {
        final pulseOpacity =
            widget.showPulse ? 0.15 + _pulseController.value * 0.1 : 0.0;
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 12),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppColors.surfaceLight, width: 1),
            boxShadow: widget.showPulse
                ? [
                    BoxShadow(
                      color: widget.color.withOpacity(pulseOpacity),
                      blurRadius: 12,
                      spreadRadius: 0,
                    ),
                  ]
                : null,
          ),
          child: Column(
            children: [
              Icon(widget.icon, color: widget.color, size: 20),
              const SizedBox(height: 6),
              Text(
                '$_displayValue',
                style: TextStyle(
                  color: widget.color,
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 2),
              Text(
                widget.label,
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 10,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _MetricCardText extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;

  const _MetricCardText({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.surfaceLight, width: 1),
      ),
      child: Column(
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(height: 6),
          Text(
            value,
            style: TextStyle(
              color: color,
              fontSize: 16,
              fontWeight: FontWeight.w700,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
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

// ---------- Health Ring Chart ----------

class _HealthRingChart extends StatefulWidget {
  final List<int> distribution; // [healthy, warning, error]
  final int total;

  const _HealthRingChart({required this.distribution, required this.total});

  @override
  State<_HealthRingChart> createState() => _HealthRingChartState();
}

class _HealthRingChartState extends State<_HealthRingChart>
    with SingleTickerProviderStateMixin {
  late AnimationController _animController;

  @override
  void initState() {
    super.initState();
    _animController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    )..forward();
  }

  @override
  void dispose() {
    _animController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          const Text(
            'Agent Health',
            style: TextStyle(
              color: AppColors.textPrimary,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: 100,
            height: 100,
            child: AnimatedBuilder(
              animation: _animController,
              builder: (context, _) {
                return CustomPaint(
                  size: const Size(100, 100),
                  painter: _RingChartPainter(
                    distribution: widget.distribution,
                    total: widget.total,
                    progress: _animController.value,
                  ),
                  child: Center(
                    child: Text(
                      '${widget.total}',
                      style: const TextStyle(
                        color: AppColors.textPrimary,
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _LegendDot(
                  color: AppColors.success,
                  label: '${widget.distribution[0]}'),
              _LegendDot(
                  color: AppColors.warning,
                  label: '${widget.distribution[1]}'),
              _LegendDot(
                  color: AppColors.error,
                  label: '${widget.distribution[2]}'),
            ],
          ),
        ],
      ),
    );
  }
}

class _LegendDot extends StatelessWidget {
  final Color color;
  final String label;

  const _LegendDot({required this.color, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
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

class _RingChartPainter extends CustomPainter {
  final List<int> distribution;
  final int total;
  final double progress;

  _RingChartPainter({
    required this.distribution,
    required this.total,
    required this.progress,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.width / 2 - 8;
    const strokeWidth = 10.0;
    const startAngle = -pi / 2;

    // Background ring
    final bgPaint = Paint()
      ..color = AppColors.surfaceLight
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;
    canvas.drawCircle(center, radius, bgPaint);

    if (total == 0) return;

    final colors = [AppColors.success, AppColors.warning, AppColors.error];
    double currentAngle = startAngle;

    for (int i = 0; i < distribution.length; i++) {
      if (distribution[i] == 0) continue;
      final sweep = (distribution[i] / total) * 2 * pi * progress;
      final paint = Paint()
        ..color = colors[i]
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth
        ..strokeCap = StrokeCap.round;

      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        currentAngle,
        sweep,
        false,
        paint,
      );
      currentAngle += sweep;
    }
  }

  @override
  bool shouldRepaint(covariant _RingChartPainter oldDelegate) =>
      oldDelegate.progress != progress ||
      oldDelegate.distribution != distribution;
}

// ---------- Quick Stats Column ----------

class _QuickStatsColumn extends StatelessWidget {
  final DashboardMetrics metrics;

  const _QuickStatsColumn({required this.metrics});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        _MiniStatRow(
          icon: Icons.chat_bubble_outline,
          label: 'Sessions',
          value: '${metrics.totalSessions}',
          color: AppColors.accent,
        ),
        const SizedBox(height: 8),
        _MiniStatRow(
          icon: Icons.schedule,
          label: 'Cron Jobs',
          value: '${metrics.cronJobCount}',
          color: AppColors.warning,
        ),
        const SizedBox(height: 8),
        _MiniStatRow(
          icon: Icons.outbox,
          label: 'Queue',
          value: '${metrics.deliveryPending}',
          color: metrics.deliveryFailed > 0
              ? AppColors.error
              : AppColors.textSecondary,
        ),
        if (metrics.deliveryFailed > 0) ...[
          const SizedBox(height: 8),
          _MiniStatRow(
            icon: Icons.error_outline,
            label: 'Failed',
            value: '${metrics.deliveryFailed}',
            color: AppColors.error,
          ),
        ],
      ],
    );
  }
}

class _MiniStatRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;

  const _MiniStatRow({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.surfaceLight, width: 1),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 16),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              style: const TextStyle(
                color: AppColors.textSecondary,
                fontSize: 12,
              ),
            ),
          ),
          Text(
            value,
            style: TextStyle(
              color: color,
              fontSize: 14,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- Quick Actions (2x2 Grid) ----------

class _QuickActionsGrid extends StatelessWidget {
  final VoidCallback onNewChat;
  final VoidCallback onCreateAgent;
  final VoidCallback onAddCronJob;
  final VoidCallback onViewLogs;

  const _QuickActionsGrid({
    required this.onNewChat,
    required this.onCreateAgent,
    required this.onAddCronJob,
    required this.onViewLogs,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionHeader(title: 'QUICK ACTIONS'),
        const SizedBox(height: 8),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisSpacing: 10,
          mainAxisSpacing: 10,
          childAspectRatio: 2.2,
          children: [
            _GradientActionButton(
              icon: Icons.chat_bubble_outline,
              label: 'New Chat',
              gradient: [
                AppColors.accent.withOpacity(0.2),
                AppColors.gradientEnd.withOpacity(0.1),
              ],
              iconColor: AppColors.accent,
              onTap: onNewChat,
            ),
            _GradientActionButton(
              icon: Icons.add_circle_outline,
              label: 'Create Agent',
              gradient: [
                AppColors.success.withOpacity(0.15),
                AppColors.success.withOpacity(0.05),
              ],
              iconColor: AppColors.success,
              onTap: onCreateAgent,
            ),
            _GradientActionButton(
              icon: Icons.schedule,
              label: 'Add Cron Job',
              gradient: [
                AppColors.warning.withOpacity(0.15),
                AppColors.warning.withOpacity(0.05),
              ],
              iconColor: AppColors.warning,
              onTap: onAddCronJob,
            ),
            _GradientActionButton(
              icon: Icons.description_outlined,
              label: 'Settings',
              gradient: [
                AppColors.info.withOpacity(0.15),
                AppColors.info.withOpacity(0.05),
              ],
              iconColor: AppColors.info,
              onTap: onViewLogs,
            ),
          ],
        ),
      ],
    );
  }
}

class _GradientActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final List<Color> gradient;
  final Color iconColor;
  final VoidCallback onTap;

  const _GradientActionButton({
    required this.icon,
    required this.label,
    required this.gradient,
    required this.iconColor,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () {
          HapticFeedback.lightImpact();
          onTap();
        },
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              colors: gradient,
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: iconColor.withOpacity(0.2),
              width: 1,
            ),
          ),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: iconColor.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(icon, color: iconColor, size: 20),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------- Recent Messages Section ----------

class _RecentMessagesSection extends StatelessWidget {
  final List<RecentMessage> messages;

  const _RecentMessagesSection({required this.messages});

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        children: messages.asMap().entries.map((entry) {
          final index = entry.key;
          final msg = entry.value;
          return Column(
            children: [
              if (index > 0)
                const Divider(
                  height: 1,
                  indent: 52,
                  color: AppColors.surfaceLight,
                ),
              InkWell(
                onTap: () {
                  HapticFeedback.lightImpact();
                  context.push('/chat/${msg.agentId}');
                },
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  child: Row(
                    children: [
                      const Icon(Icons.chat_bubble_outline,
                          color: AppColors.accent, size: 16),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              msg.agentName,
                              style: const TextStyle(
                                color: AppColors.textPrimary,
                                fontSize: 13,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              msg.preview,
                              style: const TextStyle(
                                color: AppColors.textSecondary,
                                fontSize: 11,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                      Text(
                        msg.timeAgo,
                        style: const TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 10,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        }).toList(),
      ),
    );
  }
}

// ---------- Activity Timeline ----------

class _ActivityTimeline extends StatelessWidget {
  final List<Agent> agents;

  const _ActivityTimeline({required this.agents});

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(14),
      child: Column(
        children: agents.asMap().entries.map((entry) {
          final index = entry.key;
          final agent = entry.value;
          final isLast = index == agents.length - 1;

          return IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Timeline line
                SizedBox(
                  width: 24,
                  child: Column(
                    children: [
                      Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          color: agent.isActive
                              ? AppColors.success
                              : AppColors.offline,
                          shape: BoxShape.circle,
                          boxShadow: agent.isActive
                              ? [
                                  BoxShadow(
                                    color:
                                        AppColors.success.withOpacity(0.3),
                                    blurRadius: 4,
                                    spreadRadius: 1,
                                  ),
                                ]
                              : null,
                        ),
                      ),
                      if (!isLast)
                        Expanded(
                          child: Container(
                            width: 1.5,
                            color: AppColors.surfaceLight,
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                // Content
                Expanded(
                  child: GestureDetector(
                    onTap: () {
                      HapticFeedback.lightImpact();
                      context.push('/chat/${agent.id}');
                    },
                    child: Padding(
                      padding: EdgeInsets.only(bottom: isLast ? 0 : 16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  agent.displayName,
                                  style: const TextStyle(
                                    color: AppColors.textPrimary,
                                    fontSize: 13,
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                              ),
                              Text(
                                agent.lastActivityText,
                                style: const TextStyle(
                                  color: AppColors.textSecondary,
                                  fontSize: 10,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 2),
                          Text(
                            agent.isActive
                                ? 'Active session - ${agent.sessions} total sessions'
                                : 'Offline - ${agent.sessions} sessions total',
                            style: TextStyle(
                              color: agent.isActive
                                  ? AppColors.success
                                  : AppColors.textSecondary,
                              fontSize: 11,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          );
        }).toList(),
      ),
    );
  }
}

// ---------- System Resources Section ----------

class _SystemResourcesSection extends StatelessWidget {
  final DashboardMetrics metrics;
  final StatusState statusState;

  const _SystemResourcesSection({
    required this.metrics,
    required this.statusState,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionHeader(title: 'SYSTEM RESOURCES'),
        const SizedBox(height: 8),
        GlassCard(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              _ResourceRow(
                icon: Icons.timer_outlined,
                label: 'Server Uptime',
                value: metrics.uptime,
                color: AppColors.info,
              ),
              const SizedBox(height: 12),
              _ResourceBar(
                label: 'Active Agents',
                current: metrics.activeAgents,
                total: max(metrics.totalAgents, 1),
                color: AppColors.success,
              ),
              const SizedBox(height: 12),
              _ResourceRow(
                icon: Icons.hub_outlined,
                label: 'Active Connections',
                value: '${metrics.totalSessions}',
                color: AppColors.accent,
              ),
              const SizedBox(height: 12),
              _ResourceRow(
                icon: Icons.schedule,
                label: 'Cron Jobs',
                value: '${metrics.cronJobCount}',
                color: AppColors.warning,
              ),
              if (metrics.deliveryFailed > 0) ...[
                const SizedBox(height: 12),
                _ResourceRow(
                  icon: Icons.error_outline,
                  label: 'Delivery Failures',
                  value: '${metrics.deliveryFailed}',
                  color: AppColors.error,
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _ResourceRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;

  const _ResourceRow({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: color, size: 18),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            label,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 13,
            ),
          ),
        ),
        Text(
          value,
          style: TextStyle(
            color: color,
            fontSize: 14,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}

class _ResourceBar extends StatelessWidget {
  final String label;
  final int current;
  final int total;
  final Color color;

  const _ResourceBar({
    required this.label,
    required this.current,
    required this.total,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final fraction = total > 0 ? (current / total).clamp(0.0, 1.0) : 0.0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.smart_toy, color: color, size: 18),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                label,
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 13,
                ),
              ),
            ),
            Text(
              '$current / $total',
              style: TextStyle(
                color: color,
                fontSize: 14,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: fraction,
            backgroundColor: AppColors.surfaceLight,
            valueColor: AlwaysStoppedAnimation<Color>(color),
            minHeight: 6,
          ),
        ),
      ],
    );
  }
}

// ---------- Section Header ----------

class _SectionHeader extends StatelessWidget {
  final String title;

  const _SectionHeader({required this.title});

  @override
  Widget build(BuildContext context) {
    return Text(
      title,
      style: const TextStyle(
        color: AppColors.textSecondary,
        fontSize: 11,
        fontWeight: FontWeight.w600,
        letterSpacing: 1,
      ),
    );
  }
}

// ---------- Agent Health Grid ----------

class _AgentHealthGrid extends StatelessWidget {
  final List<Agent> agents;

  const _AgentHealthGrid({required this.agents});

  @override
  Widget build(BuildContext context) {
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        crossAxisSpacing: 10,
        mainAxisSpacing: 10,
        childAspectRatio: 1.35,
      ),
      itemCount: agents.length,
      itemBuilder: (context, index) {
        final agent = agents[index];
        return _AgentHealthCard(agent: agent);
      },
    );
  }
}

class _AgentHealthCard extends StatefulWidget {
  final Agent agent;

  const _AgentHealthCard({required this.agent});

  @override
  State<_AgentHealthCard> createState() => _AgentHealthCardState();
}

class _AgentHealthCardState extends State<_AgentHealthCard>
    with SingleTickerProviderStateMixin {
  late AnimationController _pulseController;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
    if (widget.agent.isActive) {
      _pulseController.repeat(reverse: true);
    }
  }

  @override
  void didUpdateWidget(covariant _AgentHealthCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.agent.isActive && !_pulseController.isAnimating) {
      _pulseController.repeat(reverse: true);
    } else if (!widget.agent.isActive && _pulseController.isAnimating) {
      _pulseController.stop();
    }
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final agent = widget.agent;

    return GestureDetector(
      onTap: () {
        HapticFeedback.lightImpact();
        context.push('/agents/${agent.id}/detail');
      },
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.surfaceLight, width: 1),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Row(
              children: [
                AnimatedBuilder(
                  animation: _pulseController,
                  builder: (context, _) {
                    final opacity = agent.isActive
                        ? 0.7 + _pulseController.value * 0.3
                        : 1.0;
                    return Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: (agent.isActive
                                ? AppColors.online
                                : AppColors.offline)
                            .withOpacity(opacity),
                        shape: BoxShape.circle,
                        boxShadow: agent.isActive
                            ? [
                                BoxShadow(
                                  color: AppColors.online.withOpacity(
                                      0.3 * _pulseController.value),
                                  blurRadius: 6,
                                  spreadRadius: 1,
                                ),
                              ]
                            : null,
                      ),
                    );
                  },
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    agent.displayName,
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: agent.modelColor.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    agent.modelBadge,
                    style: TextStyle(
                      color: agent.modelColor,
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    Text(
                      '${agent.sessions} sessions',
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 10,
                      ),
                    ),
                    const Spacer(),
                    Text(
                      agent.lastActivityText,
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 10,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
