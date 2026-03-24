import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/agents/agents_provider.dart';
import 'package:tamerclaw_mobile/features/status/status_provider.dart';
import 'package:tamerclaw_mobile/shared/models/agent.dart';
import 'package:tamerclaw_mobile/shared/models/cron_job.dart';

class CronJobsScreen extends ConsumerWidget {
  const CronJobsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(statusProvider);
    final jobs = state.cronJobs;

    // Group by agent
    final grouped = <String, List<CronJob>>{};
    for (final job in jobs) {
      grouped.putIfAbsent(job.agentId, () => []).add(job);
    }

    // Sort: managed agents first, then system
    final sortedKeys = grouped.keys.toList()
      ..sort((a, b) {
        final aSystem = grouped[a]!.every((j) => j.isSystem);
        final bSystem = grouped[b]!.every((j) => j.isSystem);
        if (aSystem && !bSystem) return 1;
        if (!aSystem && bSystem) return -1;
        return a.compareTo(b);
      });

    return Scaffold(
      appBar: AppBar(
        title: const Text('Cron Jobs'),
        automaticallyImplyLeading: false,
        actions: [
          if (jobs.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: Center(
                child: Text(
                  '${jobs.length} job${jobs.length == 1 ? '' : 's'}',
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 13,
                  ),
                ),
              ),
            ),
        ],
      ),
      body: state.isLoading && jobs.isEmpty
          ? _CronLoadingSkeleton()
          : jobs.isEmpty
              ? _EmptyCronState()
              : RefreshIndicator(
                  onRefresh: () {
                    HapticFeedback.mediumImpact();
                    return ref.read(statusProvider.notifier).fetchAll();
                  },
                  color: AppColors.accent,
                  child: ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: sortedKeys.length,
                    itemBuilder: (context, index) {
                      final agentId = sortedKeys[index];
                      final agentJobs = grouped[agentId]!;
                      final agent = ref.watch(agentByIdProvider(agentId));

                      return _AgentJobGroup(
                        agentId: agentId,
                        agentName: agent?.displayName ?? _formatAgentName(agentId),
                        jobs: agentJobs,
                        onToggle: (job) =>
                            ref.read(statusProvider.notifier).toggleCronJob(job),
                        onDelete: (job) => _confirmDelete(context, ref, job),
                      );
                    },
                  ),
                ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _showCreateDialog(context, ref),
        backgroundColor: AppColors.accent,
        child: const Icon(Icons.add, color: Colors.white),
      ),
    );
  }

  String _formatAgentName(String id) {
    if (id == 'system') return 'System';
    return id.split('-').map((w) => w.isNotEmpty
        ? '${w[0].toUpperCase()}${w.substring(1)}'
        : w).join(' ');
  }

  void _confirmDelete(BuildContext context, WidgetRef ref, CronJob job) {
    if (job.isSystem) return; // System jobs can't be deleted from app
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Delete Job',
            style: TextStyle(color: AppColors.textPrimary)),
        content: Text(
          'Delete "${job.name}"?',
          style: const TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              ref.read(statusProvider.notifier).deleteCronJob(job.id);
            },
            child:
                const Text('Delete', style: TextStyle(color: AppColors.error)),
          ),
        ],
      ),
    );
  }

  void _showCreateDialog(BuildContext context, WidgetRef ref) {
    final agents = ref.read(agentsProvider).agents;
    if (agents.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No agents available')),
      );
      return;
    }

    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => _CreateCronJobSheet(agents: agents),
    );
  }
}

// ---------- Empty state ----------

class _EmptyCronState extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
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
              child: Icon(
                Icons.schedule,
                color: AppColors.textSecondary.withOpacity(0.4),
                size: 40,
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'No cron jobs configured',
              style: TextStyle(
                color: AppColors.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 6),
            const Text(
              'Create a scheduled job to automate agent tasks',
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

// ---------- Loading skeleton ----------

class _CronLoadingSkeleton extends StatefulWidget {
  @override
  State<_CronLoadingSkeleton> createState() => _CronLoadingSkeletonState();
}

class _CronLoadingSkeletonState extends State<_CronLoadingSkeleton>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final shimmerOpacity = 0.3 + (_controller.value * 0.4);
        return ListView.builder(
          padding: const EdgeInsets.all(16),
          itemCount: 4,
          itemBuilder: (context, index) {
            return Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.surfaceLight, width: 1),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          height: 14,
                          width: 140,
                          decoration: BoxDecoration(
                            color: AppColors.surfaceLight
                                .withOpacity(shimmerOpacity),
                            borderRadius: BorderRadius.circular(4),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Container(
                          height: 10,
                          width: 200,
                          decoration: BoxDecoration(
                            color: AppColors.surfaceLight
                                .withOpacity(shimmerOpacity * 0.7),
                            borderRadius: BorderRadius.circular(4),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    width: 40,
                    height: 24,
                    decoration: BoxDecoration(
                      color: AppColors.surfaceLight
                          .withOpacity(shimmerOpacity * 0.8),
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }
}

// ---------- Agent job group ----------

class _AgentJobGroup extends StatelessWidget {
  final String agentId;
  final String agentName;
  final List<CronJob> jobs;
  final ValueChanged<CronJob> onToggle;
  final ValueChanged<CronJob> onDelete;

  const _AgentJobGroup({
    required this.agentId,
    required this.agentName,
    required this.jobs,
    required this.onToggle,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 8, bottom: 8),
          child: Row(
            children: [
              Text(
                agentName.toUpperCase(),
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.5,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '${jobs.length}',
                style: TextStyle(
                  color: AppColors.textSecondary.withOpacity(0.5),
                  fontSize: 11,
                ),
              ),
            ],
          ),
        ),
        ...jobs.map((job) => _buildJobCard(job)),
      ],
    );
  }

  Widget _buildJobCard(CronJob job) {
    if (job.isSystem) {
      // System jobs — read-only, distinct styling
      return Card(
        margin: const EdgeInsets.only(bottom: 8),
        color: AppColors.surface.withOpacity(0.7),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 6,
                height: 36,
                decoration: BoxDecoration(
                  color: AppColors.textSecondary.withOpacity(0.3),
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            job.name,
                            style: const TextStyle(
                              color: AppColors.textPrimary,
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: AppColors.surfaceLight.withOpacity(0.5),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: const Text(
                            'SYSTEM',
                            style: TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 9,
                              fontWeight: FontWeight.w600,
                              letterSpacing: 0.5,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        const Icon(Icons.schedule,
                            size: 12, color: AppColors.textSecondary),
                        const SizedBox(width: 4),
                        Text(
                          job.humanSchedule,
                          style: const TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                    if (job.command != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        _truncateCommand(job.command!),
                        style: TextStyle(
                          color: AppColors.textSecondary.withOpacity(0.5),
                          fontSize: 10,
                          fontFamily: 'monospace',
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    }

    // Managed jobs — interactive with toggle and swipe-to-delete
    return Dismissible(
      key: ValueKey(job.id),
      direction: DismissDirection.endToStart,
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 20),
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          color: AppColors.error,
          borderRadius: BorderRadius.circular(12),
        ),
        child: const Icon(Icons.delete, color: Colors.white),
      ),
      confirmDismiss: (_) async {
        onDelete(job);
        return false;
      },
      child: Card(
        margin: const EdgeInsets.only(bottom: 8),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 6,
                height: 36,
                decoration: BoxDecoration(
                  color: job.enabled
                      ? AppColors.accent
                      : AppColors.textSecondary.withOpacity(0.3),
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      job.name,
                      style: const TextStyle(
                        color: AppColors.textPrimary,
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        const Icon(Icons.schedule,
                            size: 12, color: AppColors.textSecondary),
                        const SizedBox(width: 4),
                        Text(
                          job.humanSchedule,
                          style: const TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 12,
                          ),
                        ),
                        const SizedBox(width: 12),
                        const Icon(Icons.history,
                            size: 12, color: AppColors.textSecondary),
                        const SizedBox(width: 4),
                        Text(
                          'Last: ${job.lastRunText}',
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
              SizedBox(
                height: 28,
                child: Switch(
                  value: job.enabled,
                  onChanged: (_) {
                    HapticFeedback.selectionClick();
                    onToggle(job);
                  },
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _truncateCommand(String cmd) {
    // Show just the script/binary name, not full path
    final match = RegExp(r'[\w-]+\.(py|sh|js)').firstMatch(cmd);
    if (match != null) return match.group(0)!;
    if (cmd.length > 50) return '${cmd.substring(0, 50)}...';
    return cmd;
  }
}

// ---------- Create cron job sheet ----------

class _CreateCronJobSheet extends ConsumerStatefulWidget {
  final List<Agent> agents;

  const _CreateCronJobSheet({required this.agents});

  @override
  ConsumerState<_CreateCronJobSheet> createState() =>
      _CreateCronJobSheetState();
}

class _CreateCronJobSheetState extends ConsumerState<_CreateCronJobSheet> {
  final _nameController = TextEditingController();
  final _scheduleController = TextEditingController();
  final _messageController = TextEditingController();
  String? _selectedAgentId;
  bool _isCreating = false;

  @override
  void initState() {
    super.initState();
    _selectedAgentId = widget.agents.first.id;
  }

  @override
  void dispose() {
    _nameController.dispose();
    _scheduleController.dispose();
    _messageController.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    if (_nameController.text.trim().isEmpty ||
        _scheduleController.text.trim().isEmpty ||
        _selectedAgentId == null) {
      return;
    }

    setState(() => _isCreating = true);

    try {
      await ref.read(statusProvider.notifier).createCronJob(
            agentId: _selectedAgentId!,
            name: _nameController.text.trim(),
            schedule: _scheduleController.text.trim(),
            message: _messageController.text.trim(),
          );
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString()),
            backgroundColor: AppColors.error,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isCreating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        16,
        16,
        16,
        16 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: AppColors.surfaceLight,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Create Cron Job',
            style: TextStyle(
              color: AppColors.textPrimary,
              fontSize: 18,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 20),

          // Agent picker
          DropdownButtonFormField<String>(
            value: _selectedAgentId,
            dropdownColor: AppColors.surfaceLight,
            style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
            decoration: const InputDecoration(
              labelText: 'Agent',
              labelStyle: TextStyle(color: AppColors.textSecondary),
            ),
            items: widget.agents.map((a) {
              return DropdownMenuItem(
                value: a.id,
                child: Text(a.displayName),
              );
            }).toList(),
            onChanged: (v) => setState(() => _selectedAgentId = v),
          ),
          const SizedBox(height: 12),

          TextField(
            controller: _nameController,
            style: const TextStyle(color: AppColors.textPrimary),
            decoration: const InputDecoration(
              labelText: 'Job Name',
              labelStyle: TextStyle(color: AppColors.textSecondary),
              hintText: 'e.g. Daily report',
            ),
          ),
          const SizedBox(height: 12),

          TextField(
            controller: _scheduleController,
            style: const TextStyle(color: AppColors.textPrimary),
            decoration: const InputDecoration(
              labelText: 'Cron Schedule',
              labelStyle: TextStyle(color: AppColors.textSecondary),
              hintText: 'e.g. 0 9 * * * (daily at 9am)',
            ),
          ),
          const SizedBox(height: 12),

          TextField(
            controller: _messageController,
            style: const TextStyle(color: AppColors.textPrimary),
            maxLines: 3,
            minLines: 1,
            decoration: const InputDecoration(
              labelText: 'Message (optional)',
              labelStyle: TextStyle(color: AppColors.textSecondary),
              hintText: 'Message to send to agent',
            ),
          ),
          const SizedBox(height: 20),

          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _isCreating ? null : _create,
              child: _isCreating
                  ? const SizedBox(
                      height: 20,
                      width: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Text('Create Job'),
            ),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
