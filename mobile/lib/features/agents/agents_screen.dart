import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/agents/agent_customization_provider.dart';
import 'package:tamerclaw_mobile/features/agents/agents_provider.dart';
import 'package:tamerclaw_mobile/features/agents/agent_tile.dart';
import 'package:tamerclaw_mobile/features/agents/widgets/agent_options_sheet.dart';
import 'package:tamerclaw_mobile/features/agents/widgets/icon_picker_dialog.dart';
import 'package:tamerclaw_mobile/features/agents/widgets/rename_agent_dialog.dart';
import 'package:tamerclaw_mobile/shared/models/agent.dart';
import 'package:tamerclaw_mobile/shared/models/agent_customization.dart';

class AgentsScreen extends ConsumerWidget {
  const AgentsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agentsState = ref.watch(agentsProvider);
    final filteredAgents = ref.watch(filteredAgentsProvider);
    final searchQuery = ref.watch(agentSearchQueryProvider);
    final recentAgents = ref.watch(recentAgentsProvider);
    final favoriteIds = ref.watch(favoriteAgentIdsProvider);
    final customizations = ref.watch(agentCustomizationProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Agents'),
        actions: [
          if (agentsState.isLoading)
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
      body: Column(
        children: [
          // Search bar
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: TextField(
              style: const TextStyle(color: AppColors.textPrimary),
              decoration: InputDecoration(
                hintText: 'Search agents...',
                prefixIcon:
                    const Icon(Icons.search, color: AppColors.textSecondary),
                suffixIcon: searchQuery.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear,
                            color: AppColors.textSecondary),
                        onPressed: () =>
                            ref.read(agentSearchQueryProvider.notifier).state =
                                '',
                      )
                    : null,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 10),
              ),
              onChanged: (value) =>
                  ref.read(agentSearchQueryProvider.notifier).state = value,
            ),
          ),

          // Content
          Expanded(
            child: _buildContent(
              context,
              ref,
              agentsState,
              filteredAgents,
              recentAgents,
              searchQuery,
              favoriteIds,
              customizations,
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.push('/agents/create'),
        backgroundColor: AppColors.accent,
        child: const Icon(Icons.add, color: Colors.white),
      ),
    );
  }

  Widget _buildContent(
    BuildContext context,
    WidgetRef ref,
    AgentsState agentsState,
    List<Agent> filteredAgents,
    List<Agent> recentAgents,
    String searchQuery,
    Set<String> favoriteIds,
    Map<String, AgentCustomization> customizations,
  ) {
    if (agentsState.isLoading && agentsState.agents.isEmpty) {
      return _ShimmerAgentList();
    }

    if (agentsState.error != null && agentsState.agents.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.error, size: 48),
              const SizedBox(height: 16),
              Text(
                agentsState.error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.textSecondary),
              ),
              const SizedBox(height: 16),
              TextButton(
                onPressed: () =>
                    ref.read(agentsProvider.notifier).fetchAgents(),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    if (filteredAgents.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                agentsState.agents.isEmpty
                    ? Icons.smart_toy_outlined
                    : Icons.search_off,
                color: AppColors.textSecondary.withOpacity(0.3),
                size: 64,
              ),
              const SizedBox(height: 16),
              Text(
                agentsState.agents.isEmpty
                    ? 'No agents yet'
                    : 'No matching agents',
                style: const TextStyle(
                  color: AppColors.textPrimary,
                  fontSize: 16,
                  fontWeight: FontWeight.w500,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                agentsState.agents.isEmpty
                    ? 'Create your first agent to get started'
                    : 'Try a different search term',
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 13,
                ),
              ),
            ],
          ),
        ),
      );
    }

    // Split into favorites and non-favorites
    final favoriteAgents =
        filteredAgents.where((a) => favoriteIds.contains(a.id)).toList();
    final otherAgents =
        filteredAgents.where((a) => !favoriteIds.contains(a.id)).toList();

    return RefreshIndicator(
      onRefresh: () => ref.read(agentsProvider.notifier).fetchAgents(),
      color: AppColors.accent,
      child: ListView(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        children: [
          // Recent conversations (horizontal chips)
          if (recentAgents.isNotEmpty && searchQuery.isEmpty) ...[
            const Padding(
              padding: EdgeInsets.only(top: 8, bottom: 8),
              child: Text(
                'Recent Conversations',
                style: TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.5,
                ),
              ),
            ),
            SizedBox(
              height: 40,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: recentAgents.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (context, index) {
                  final agent = recentAgents[index];
                  final cust = customizations[agent.id];
                  final name = cust?.customName ?? agent.displayName;
                  return ActionChip(
                    avatar: CircleAvatar(
                      radius: 10,
                      backgroundColor: agent.modelColor.withOpacity(0.2),
                      child: cust?.iconCodePoint != null
                          ? Icon(
                              IconData(
                                cust!.iconCodePoint!,
                                fontFamily:
                                    cust.iconFontFamily ?? 'MaterialIcons',
                              ),
                              size: 12,
                              color: agent.modelColor,
                            )
                          : Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: agent.isActive
                                    ? AppColors.online
                                    : AppColors.offline,
                                shape: BoxShape.circle,
                              ),
                            ),
                    ),
                    label: Text(
                      name,
                      style: const TextStyle(
                        color: AppColors.textPrimary,
                        fontSize: 12,
                      ),
                    ),
                    backgroundColor: AppColors.surfaceLight,
                    side: BorderSide.none,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(20),
                    ),
                    onPressed: () {
                      ref.read(recentAgentIdsProvider.notifier).add(agent.id);
                      context.push('/chat/${agent.id}');
                    },
                  );
                },
              ),
            ),
            const SizedBox(height: 12),
          ],

          // ===== Favorites section =====
          if (favoriteAgents.isNotEmpty && searchQuery.isEmpty) ...[
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 8),
              child: Row(
                children: [
                  const Icon(Icons.star, color: Colors.amber, size: 16),
                  const SizedBox(width: 6),
                  Text(
                    'Favorites (${favoriteAgents.length})',
                    style: const TextStyle(
                      color: Colors.amber,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.5,
                    ),
                  ),
                ],
              ),
            ),
            ...favoriteAgents.map((agent) => _buildAgentEntry(
                  context, ref, agent, customizations)),
            const SizedBox(height: 8),
          ],

          // ===== All / Other agents header =====
          if (searchQuery.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 8),
              child: Text(
                favoriteAgents.isNotEmpty
                    ? 'Other Agents (${otherAgents.length})'
                    : 'All Agents (${filteredAgents.length})',
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.5,
                ),
              ),
            ),

          // If searching, show all filtered; otherwise show non-favorites
          ...(searchQuery.isNotEmpty ? filteredAgents : otherAgents)
              .map((agent) => _buildAgentEntry(
                    context, ref, agent, customizations)),

          // Bottom padding for FAB
          const SizedBox(height: 80),
        ],
      ),
    );
  }

  Widget _buildAgentEntry(
    BuildContext context,
    WidgetRef ref,
    Agent agent,
    Map<String, AgentCustomization> customizations,
  ) {
    final cust = customizations[agent.id] ?? const AgentCustomization();

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Dismissible(
        key: ValueKey('agent-${agent.id}'),
        background: Container(
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.only(left: 20),
          decoration: BoxDecoration(
            color: AppColors.accent,
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Icon(Icons.chat_bubble, color: Colors.white),
        ),
        secondaryBackground: Container(
          alignment: Alignment.centerRight,
          padding: const EdgeInsets.only(right: 20),
          decoration: BoxDecoration(
            color: AppColors.error,
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Icon(Icons.delete, color: Colors.white),
        ),
        confirmDismiss: (direction) async {
          if (direction == DismissDirection.startToEnd) {
            ref.read(recentAgentIdsProvider.notifier).add(agent.id);
            context.push('/chat/${agent.id}');
            return false;
          } else {
            return await _confirmDelete(context, ref, agent, cust);
          }
        },
        child: AgentTile(
          agent: agent,
          customization: cust,
          onTap: () {
            ref.read(recentAgentIdsProvider.notifier).add(agent.id);
            context.push('/chat/${agent.id}');
          },
          onLongPress: () => _handleLongPress(context, ref, agent, cust),
          onFavoriteToggle: () {
            ref
                .read(agentCustomizationProvider.notifier)
                .toggleFavorite(agent.id);
          },
        ),
      ),
    );
  }

  Future<void> _handleLongPress(
    BuildContext context,
    WidgetRef ref,
    Agent agent,
    AgentCustomization cust,
  ) async {
    final option = await AgentOptionsSheet.show(
      context,
      agent: agent,
      customization: cust,
    );

    if (option == null || !context.mounted) return;

    switch (option) {
      case AgentOption.toggleFavorite:
        ref
            .read(agentCustomizationProvider.notifier)
            .toggleFavorite(agent.id);
        break;

      case AgentOption.rename:
        final currentName = cust.customName ?? agent.displayName;
        final newName = await RenameAgentDialog.show(
          context,
          currentName: currentName,
          agentId: agent.id,
        );
        if (newName != null && context.mounted) {
          ref.read(agentCustomizationProvider.notifier).setCustomName(
                agent.id,
                newName.isEmpty ? null : newName,
              );
          if (context.mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(newName.isEmpty
                    ? 'Reset to default name'
                    : 'Renamed to "$newName"'),
                duration: const Duration(seconds: 2),
              ),
            );
          }
        }
        break;

      case AgentOption.pickIcon:
        IconData? currentIcon;
        if (cust.iconCodePoint != null) {
          currentIcon = IconData(
            cust.iconCodePoint!,
            fontFamily: cust.iconFontFamily ?? 'MaterialIcons',
          );
        }
        final icon = await IconPickerDialog.show(
          context,
          currentIcon: currentIcon,
        );
        if (context.mounted && icon != null) {
          if (icon == IconPickerDialog.resetSentinel) {
            // User tapped "Reset to Default"
            ref
                .read(agentCustomizationProvider.notifier)
                .setCustomIcon(agent.id, null);
          } else {
            // User picked a real icon
            ref
                .read(agentCustomizationProvider.notifier)
                .setCustomIcon(agent.id, icon);
          }
        }
        break;

      case AgentOption.viewDetails:
        context.push('/agents/${agent.id}/detail');
        break;
    }
  }

  Future<bool> _confirmDelete(
    BuildContext context,
    WidgetRef ref,
    Agent agent,
    AgentCustomization cust,
  ) async {
    final displayName = cust.customName ?? agent.displayName;
    final result = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Delete Agent',
            style: TextStyle(color: AppColors.textPrimary)),
        content: Text(
          'Delete "$displayName"? This cannot be undone.',
          style: const TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child:
                const Text('Delete', style: TextStyle(color: AppColors.error)),
          ),
        ],
      ),
    );

    if (result == true) {
      try {
        await ref.read(agentsProvider.notifier).deleteAgent(agent.id);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('"$displayName" deleted')),
          );
        }
        return true;
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
    }
    return false;
  }
}

// ---------- Shimmer loading list ----------

class _ShimmerAgentList extends StatefulWidget {
  @override
  State<_ShimmerAgentList> createState() => _ShimmerAgentListState();
}

class _ShimmerAgentListState extends State<_ShimmerAgentList>
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
          itemCount: 6,
          itemBuilder: (context, index) {
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
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: AppColors.surfaceLight.withOpacity(shimmerOpacity),
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          height: 14,
                          width: 120,
                          decoration: BoxDecoration(
                            color: AppColors.surfaceLight
                                .withOpacity(shimmerOpacity),
                            borderRadius: BorderRadius.circular(4),
                          ),
                        ),
                        const SizedBox(height: 6),
                        Container(
                          height: 10,
                          width: 80,
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
                    height: 24,
                    width: 50,
                    decoration: BoxDecoration(
                      color: AppColors.surfaceLight
                          .withOpacity(shimmerOpacity * 0.8),
                      borderRadius: BorderRadius.circular(8),
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
