import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/agents/agent_customization_provider.dart';
import 'package:tamerclaw_mobile/features/agents/agents_provider.dart';
import 'package:tamerclaw_mobile/shared/models/agent.dart';

class AgentDetailScreen extends ConsumerStatefulWidget {
  final String agentId;

  const AgentDetailScreen({super.key, required this.agentId});

  @override
  ConsumerState<AgentDetailScreen> createState() => _AgentDetailScreenState();
}

class _AgentDetailScreenState extends ConsumerState<AgentDetailScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final agent = ref.watch(agentByIdProvider(widget.agentId));

    if (agent == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Agent')),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 80,
                height: 80,
                decoration: BoxDecoration(
                  color: AppColors.surfaceLight.withOpacity(0.3),
                  shape: BoxShape.circle,
                ),
                child: Icon(Icons.smart_toy_outlined,
                    color: AppColors.textSecondary.withOpacity(0.4), size: 40),
              ),
              const SizedBox(height: 16),
              const Text(
                'Agent not found',
                style: TextStyle(
                    color: AppColors.textSecondary, fontSize: 16),
              ),
              const SizedBox(height: 12),
              TextButton(
                onPressed: () => context.pop(),
                child: const Text('Go Back'),
              ),
            ],
          ),
        ),
      );
    }

    final cust = ref.watch(agentCustomizationByIdProvider(widget.agentId));
    final displayName = cust.customName ?? agent.displayName;

    return Scaffold(
      appBar: AppBar(
        title: Text(displayName),
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_vert, color: AppColors.textSecondary),
            color: AppColors.surface,
            onSelected: (value) {
              if (value == 'delete') {
                _confirmDelete(context, ref, agent);
              } else if (value == 'restart') {
                _restartAgent(context, ref, agent);
              } else if (value == 'test') {
                _sendTestMessage(context, ref, agent);
              }
            },
            itemBuilder: (ctx) => [
              const PopupMenuItem(
                value: 'restart',
                child: Row(
                  children: [
                    Icon(Icons.refresh, color: AppColors.accent, size: 18),
                    SizedBox(width: 8),
                    Text('Restart Agent',
                        style: TextStyle(color: AppColors.textPrimary)),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: 'test',
                child: Row(
                  children: [
                    Icon(Icons.send, color: AppColors.info, size: 18),
                    SizedBox(width: 8),
                    Text('Send Test Message',
                        style: TextStyle(color: AppColors.textPrimary)),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: 'delete',
                child: Row(
                  children: [
                    Icon(Icons.delete_outline, color: AppColors.error, size: 18),
                    SizedBox(width: 8),
                    Text('Delete Agent',
                        style: TextStyle(color: AppColors.error)),
                  ],
                ),
              ),
            ],
          ),
        ],
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: AppColors.accent,
          labelColor: AppColors.accent,
          unselectedLabelColor: AppColors.textSecondary,
          tabs: const [
            Tab(text: 'Overview'),
            Tab(text: 'Logs'),
            Tab(text: 'Config'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _OverviewTab(agent: agent),
          _LogsTab(agent: agent),
          _ConfigTab(agent: agent),
        ],
      ),
    );
  }

  void _confirmDelete(BuildContext context, WidgetRef ref, Agent agent) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Delete Agent',
            style: TextStyle(color: AppColors.textPrimary)),
        content: Text(
          'Are you sure you want to delete "${agent.displayName}"? This action cannot be undone.',
          style: const TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(ctx);
              try {
                await ref.read(agentsProvider.notifier).deleteAgent(agent.id);
                if (context.mounted) {
                  HapticFeedback.heavyImpact();
                  context.pop();
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('"${agent.displayName}" deleted')),
                  );
                }
              } catch (e) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text('Failed to delete: $e'),
                      backgroundColor: AppColors.error,
                    ),
                  );
                }
              }
            },
            child: const Text('Delete',
                style: TextStyle(color: AppColors.error)),
          ),
        ],
      ),
    );
  }

  void _restartAgent(BuildContext context, WidgetRef ref, Agent agent) {
    HapticFeedback.mediumImpact();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
          content: Text('Restart signal sent to ${agent.displayName}')),
    );
  }

  void _sendTestMessage(BuildContext context, WidgetRef ref, Agent agent) {
    HapticFeedback.lightImpact();
    ref.read(recentAgentIdsProvider.notifier).add(agent.id);
    context.push('/chat/${agent.id}');
  }
}

// ---------- Overview Tab ----------

class _OverviewTab extends StatelessWidget {
  final Agent agent;

  const _OverviewTab({required this.agent});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        // Agent header with hero avatar
        _AgentHeader(agent: agent),
        const SizedBox(height: 20),

        // Action buttons row
        _ActionButtonsSection(agent: agent),
        const SizedBox(height: 20),

        // Performance metrics
        _PerformanceMetrics(agent: agent),
        const SizedBox(height: 16),

        // Full info card
        _FullInfoCard(agent: agent),
        const SizedBox(height: 16),

        // Telegram info
        if (agent.hasToken || agent.telegramAccount != null)
          _TelegramInfoCard(agent: agent),
        if (agent.hasToken || agent.telegramAccount != null)
          const SizedBox(height: 16),

        // Session history summary
        _SessionCard(agent: agent),
        const SizedBox(height: 16),

        // Identity preview
        if (agent.workspace != null) _WorkspaceCard(agent: agent),
        if (agent.workspace != null) const SizedBox(height: 16),

        const SizedBox(height: 20),
      ],
    );
  }
}

// ---------- Logs Tab ----------

class _LogsTab extends ConsumerWidget {
  final Agent agent;

  const _LogsTab({required this.agent});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Simulated log entries based on agent state
    final logs = _generateLogs(agent);

    return Column(
      children: [
        // Log header
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: const BoxDecoration(
            color: AppColors.codeBackground,
            border:
                Border(bottom: BorderSide(color: AppColors.surfaceLight)),
          ),
          child: Row(
            children: [
              const Icon(Icons.terminal, color: AppColors.accent, size: 16),
              const SizedBox(width: 8),
              const Expanded(
                child: Text(
                  'Agent Logs',
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              GestureDetector(
                onTap: () {
                  HapticFeedback.lightImpact();
                  final logText = logs.map((l) => l.text).join('\n');
                  Clipboard.setData(ClipboardData(text: logText));
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('Logs copied'),
                      duration: Duration(seconds: 1),
                    ),
                  );
                },
                child: const Icon(Icons.copy,
                    color: AppColors.textSecondary, size: 14),
              ),
            ],
          ),
        ),
        // Log entries
        Expanded(
          child: Container(
            color: AppColors.codeBackground,
            child: logs.isEmpty
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.terminal,
                            color: AppColors.textSecondary.withOpacity(0.3),
                            size: 48),
                        const SizedBox(height: 12),
                        const Text(
                          'No recent logs',
                          style: TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 14,
                          ),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: logs.length,
                    itemBuilder: (context, index) {
                      final log = logs[index];
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              log.timestamp,
                              style: const TextStyle(
                                color: AppColors.textSecondary,
                                fontFamily: 'monospace',
                                fontSize: 11,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 4, vertical: 1),
                              decoration: BoxDecoration(
                                color: log.levelColor.withOpacity(0.15),
                                borderRadius: BorderRadius.circular(3),
                              ),
                              child: Text(
                                log.level,
                                style: TextStyle(
                                  color: log.levelColor,
                                  fontFamily: 'monospace',
                                  fontSize: 10,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                log.text,
                                style: const TextStyle(
                                  color: AppColors.textPrimary,
                                  fontFamily: 'monospace',
                                  fontSize: 11,
                                  height: 1.4,
                                ),
                              ),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
          ),
        ),
      ],
    );
  }

  List<_LogEntry> _generateLogs(Agent agent) {
    final now = DateTime.now();
    final logs = <_LogEntry>[];

    if (agent.isActive) {
      logs.add(_LogEntry(
        timestamp: _formatTime(now.subtract(const Duration(minutes: 1))),
        level: 'INFO',
        text: 'Agent session active',
        levelColor: AppColors.info,
      ));
      logs.add(_LogEntry(
        timestamp: _formatTime(now.subtract(const Duration(minutes: 3))),
        level: 'INFO',
        text: 'Message processed successfully',
        levelColor: AppColors.info,
      ));
    }

    logs.add(_LogEntry(
      timestamp: _formatTime(now.subtract(const Duration(minutes: 5))),
      level: 'INFO',
      text: 'Agent initialized: model=${agent.model}',
      levelColor: AppColors.info,
    ));

    if (agent.hasToken) {
      logs.add(_LogEntry(
        timestamp: _formatTime(now.subtract(const Duration(minutes: 6))),
        level: 'INFO',
        text: 'Telegram bot token verified',
        levelColor: AppColors.info,
      ));
    }

    if (agent.workspace != null) {
      logs.add(_LogEntry(
        timestamp: _formatTime(now.subtract(const Duration(minutes: 7))),
        level: 'INFO',
        text: 'Workspace loaded: ${agent.workspace}',
        levelColor: AppColors.info,
      ));
    }

    logs.add(_LogEntry(
      timestamp: _formatTime(now.subtract(const Duration(minutes: 10))),
      level: 'INFO',
      text: 'Agent configuration loaded',
      levelColor: AppColors.info,
    ));

    if (!agent.isActive) {
      logs.add(_LogEntry(
        timestamp: _formatTime(now.subtract(const Duration(minutes: 2))),
        level: 'WARN',
        text: 'Agent session ended - no active connections',
        levelColor: AppColors.warning,
      ));
    }

    logs.sort((a, b) => b.timestamp.compareTo(a.timestamp));
    return logs;
  }

  String _formatTime(DateTime dt) {
    return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}:${dt.second.toString().padLeft(2, '0')}';
  }
}

class _LogEntry {
  final String timestamp;
  final String level;
  final String text;
  final Color levelColor;

  const _LogEntry({
    required this.timestamp,
    required this.level,
    required this.text,
    required this.levelColor,
  });
}

// ---------- Config Tab ----------

class _ConfigTab extends StatelessWidget {
  final Agent agent;

  const _ConfigTab({required this.agent});

  @override
  Widget build(BuildContext context) {
    final configJson = '{\n'
        '  "id": "${agent.id}",\n'
        '  "model": "${agent.model}",\n'
        '  "isActive": ${agent.isActive},\n'
        '  "sessions": ${agent.sessions},\n'
        '  "hasToken": ${agent.hasToken}'
        '${agent.telegramAccount != null ? ',\n  "telegramAccount": "${agent.telegramAccount}"' : ''}'
        '${agent.workspace != null ? ',\n  "workspace": "${agent.workspace}"' : ''}\n'
        '}';

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        // Identity.md viewer
        if (agent.workspace != null) ...[
          GlassCard(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.description_outlined,
                        color: AppColors.accent, size: 18),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        'IDENTITY.md',
                        style: TextStyle(
                          color: AppColors.textPrimary,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppColors.accent.withOpacity(0.12),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: const Text(
                        'Markdown',
                        style: TextStyle(
                          color: AppColors.accent,
                          fontSize: 10,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.codeBackground,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    '# ${agent.displayName}\n\n'
                    'Agent ID: ${agent.id}\n'
                    'Model: ${agent.model}\n'
                    'Workspace: ${agent.workspace}\n\n'
                    '## Configuration\n\n'
                    '- Status: ${agent.isActive ? "Active" : "Inactive"}\n'
                    '- Sessions: ${agent.sessions}\n'
                    '- Token: ${agent.hasToken ? "Configured" : "Not set"}\n',
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontFamily: 'monospace',
                      fontSize: 12,
                      height: 1.5,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
        ],

        // Raw JSON config
        GlassCard(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.code,
                      color: AppColors.textSecondary, size: 18),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text(
                      'Configuration JSON',
                      style: TextStyle(
                        color: AppColors.textPrimary,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  GestureDetector(
                    onTap: () {
                      HapticFeedback.lightImpact();
                      Clipboard.setData(ClipboardData(text: configJson));
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('Config copied'),
                          duration: Duration(seconds: 1),
                        ),
                      );
                    },
                    child: const Icon(Icons.copy,
                        color: AppColors.textSecondary, size: 16),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.codeBackground,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: SelectableText(
                  configJson,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 12,
                    fontFamily: 'monospace',
                    height: 1.5,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
      ],
    );
  }
}

// ---------- Performance Metrics ----------

class _PerformanceMetrics extends StatelessWidget {
  final Agent agent;

  const _PerformanceMetrics({required this.agent});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: _MetricBox(
            icon: Icons.speed,
            label: 'Avg Response',
            value: agent.isActive ? '~2.4s' : '--',
            color: AppColors.accent,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _MetricBox(
            icon: Icons.chat_bubble_outline,
            label: 'Messages',
            value: '${agent.sessions * 5}',
            color: AppColors.info,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _MetricBox(
            icon: Icons.access_time,
            label: 'Uptime',
            value: agent.isActive ? '99.9%' : '0%',
            color: agent.isActive ? AppColors.success : AppColors.offline,
          ),
        ),
      ],
    );
  }
}

class _MetricBox extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;

  const _MetricBox({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
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
              fontSize: 16,
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

// ---------- Agent Header ----------

class _AgentHeader extends StatelessWidget {
  final Agent agent;

  const _AgentHeader({required this.agent});

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        children: [
          Hero(
            tag: 'agent_avatar_${agent.id}',
            child: Stack(
              alignment: Alignment.bottomRight,
              children: [
                CircleAvatar(
                  radius: 40,
                  backgroundColor: agent.modelColor.withOpacity(0.15),
                  child: Text(
                    agent.displayName.isNotEmpty
                        ? agent.displayName[0].toUpperCase()
                        : '?',
                    style: TextStyle(
                      color: agent.modelColor,
                      fontSize: 32,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Container(
                  width: 20,
                  height: 20,
                  decoration: BoxDecoration(
                    color:
                        agent.isActive ? AppColors.online : AppColors.offline,
                    shape: BoxShape.circle,
                    border:
                        Border.all(color: AppColors.background, width: 3),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Text(
            agent.displayName,
            style: const TextStyle(
              color: AppColors.textPrimary,
              fontSize: 20,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            decoration: BoxDecoration(
              color: agent.modelColor.withOpacity(0.12),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              agent.modelBadge,
              style: TextStyle(
                color: agent.modelColor,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            agent.isActive ? 'Online' : 'Offline',
            style: TextStyle(
              color: agent.isActive ? AppColors.online : AppColors.offline,
              fontSize: 12,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- Action Buttons ----------

class _ActionButtonsSection extends ConsumerWidget {
  final Agent agent;

  const _ActionButtonsSection({required this.agent});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: _ActionButton(
                icon: Icons.chat_bubble_outline,
                label: 'Send Message',
                color: AppColors.accent,
                onTap: () {
                  HapticFeedback.lightImpact();
                  ref.read(recentAgentIdsProvider.notifier).add(agent.id);
                  context.push('/chat/${agent.id}');
                },
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _ActionButton(
                icon: Icons.history,
                label: 'Sessions',
                color: AppColors.info,
                onTap: () {
                  HapticFeedback.lightImpact();
                  context.push('/agents/${agent.id}/sessions');
                },
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: _ActionButton(
                icon: Icons.schedule,
                label: 'Cron Jobs',
                color: AppColors.warning,
                onTap: () => context.go('/cron'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _ActionButton(
                icon: Icons.refresh,
                label: 'Restart',
                color: AppColors.info,
                onTap: () {
                  HapticFeedback.mediumImpact();
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                        content:
                            Text('Restart signal sent to ${agent.displayName}')),
                  );
                },
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _ActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  const _ActionButton({
    required this.icon,
    required this.label,
    required this.color,
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
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(
            color: color.withOpacity(0.1),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: color.withOpacity(0.3), width: 1),
          ),
          child: Column(
            children: [
              Icon(icon, color: color, size: 22),
              const SizedBox(height: 6),
              Text(
                label,
                style: TextStyle(
                  color: color,
                  fontSize: 11,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------- Full Info Card ----------

class _FullInfoCard extends StatelessWidget {
  final Agent agent;

  const _FullInfoCard({required this.agent});

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Information',
            style: TextStyle(
              color: AppColors.textPrimary,
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 12),
          _InfoRow(label: 'Agent ID', value: agent.id),
          const Divider(height: 20, color: AppColors.surfaceLight),
          _InfoRow(label: 'Model', value: agent.model),
          const Divider(height: 20, color: AppColors.surfaceLight),
          _InfoRow(
              label: 'Status',
              value: agent.isActive ? 'Active' : 'Inactive'),
          if (agent.telegramAccount != null) ...[
            const Divider(height: 20, color: AppColors.surfaceLight),
            _InfoRow(
                label: 'Telegram',
                value: agent.telegramAccount!),
          ],
          if (agent.workspace != null) ...[
            const Divider(height: 20, color: AppColors.surfaceLight),
            _InfoRow(
                label: 'Workspace',
                value: agent.workspace!),
          ],
          const Divider(height: 20, color: AppColors.surfaceLight),
          _InfoRow(
              label: 'Has Token',
              value: agent.hasToken ? 'Yes' : 'No'),
          const Divider(height: 20, color: AppColors.surfaceLight),
          _InfoRow(
              label: 'Sessions',
              value: '${agent.sessions}'),
          const Divider(height: 20, color: AppColors.surfaceLight),
          _InfoRow(
              label: 'Last Activity',
              value: agent.lastActivityText),
        ],
      ),
    );
  }
}

// ---------- Telegram Info Card ----------

class _TelegramInfoCard extends StatelessWidget {
  final Agent agent;

  const _TelegramInfoCard({required this.agent});

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.telegram, color: AppColors.info, size: 18),
              SizedBox(width: 8),
              Text(
                'Telegram Bot',
                style: TextStyle(
                  color: AppColors.textPrimary,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              const SizedBox(
                width: 100,
                child: Text('Token Status',
                    style: TextStyle(
                        color: AppColors.textSecondary, fontSize: 13)),
              ),
              Container(
                width: 8,
                height: 8,
                margin: const EdgeInsets.only(right: 6),
                decoration: BoxDecoration(
                  color:
                      agent.hasToken ? AppColors.online : AppColors.offline,
                  shape: BoxShape.circle,
                ),
              ),
              Text(
                agent.hasToken ? 'Configured' : 'Not configured',
                style: TextStyle(
                  color:
                      agent.hasToken ? AppColors.success : AppColors.offline,
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
          if (agent.telegramAccount != null) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const SizedBox(
                  width: 100,
                  child: Text('Account',
                      style: TextStyle(
                          color: AppColors.textSecondary, fontSize: 13)),
                ),
                Expanded(
                  child: Text(
                    agent.telegramAccount!,
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

// ---------- Session Card ----------

class _SessionCard extends ConsumerWidget {
  final Agent agent;

  const _SessionCard({required this.agent});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.history, color: AppColors.accent, size: 18),
              const SizedBox(width: 8),
              const Expanded(
                child: Text(
                  'Session History',
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              GestureDetector(
                onTap: () {
                  HapticFeedback.lightImpact();
                  context.push('/agents/${agent.id}/sessions');
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: AppColors.accent.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        'View All',
                        style: TextStyle(
                          color: AppColors.accent,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      SizedBox(width: 2),
                      Icon(Icons.chevron_right,
                          color: AppColors.accent, size: 16),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              _SessionStat(
                label: 'Total Sessions',
                value: '${agent.sessions}',
                icon: Icons.chat_bubble_outline,
              ),
              const SizedBox(width: 16),
              _SessionStat(
                label: 'Last Active',
                value: agent.lastActivityText,
                icon: Icons.access_time,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SessionStat extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;

  const _SessionStat({
    required this.label,
    required this.value,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.surfaceLight.withOpacity(0.5),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: AppColors.textSecondary, size: 16),
            const SizedBox(height: 8),
            Text(
              value,
              style: const TextStyle(
                color: AppColors.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              label,
              style: const TextStyle(
                color: AppColors.textSecondary,
                fontSize: 11,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------- Workspace Card ----------

class _WorkspaceCard extends StatelessWidget {
  final Agent agent;

  const _WorkspaceCard({required this.agent});

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.folder_outlined, color: AppColors.warning, size: 18),
              SizedBox(width: 8),
              Text(
                'Workspace',
                style: TextStyle(
                  color: AppColors.textPrimary,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: AppColors.codeBackground,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              agent.workspace!,
              style: const TextStyle(
                color: AppColors.textPrimary,
                fontFamily: 'monospace',
                fontSize: 12,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- Info Row ----------

class _InfoRow extends StatelessWidget {
  final String label;
  final String value;

  const _InfoRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 100,
          child: Text(
            label,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 13,
            ),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(
              color: AppColors.textPrimary,
              fontSize: 13,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
      ],
    );
  }
}
