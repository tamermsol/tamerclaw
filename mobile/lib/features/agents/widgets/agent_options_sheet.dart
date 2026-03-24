import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/shared/models/agent.dart';
import 'package:tamerclaw_mobile/shared/models/agent_customization.dart';

enum AgentOption { rename, pickIcon, toggleFavorite, viewDetails }

class AgentOptionsSheet extends StatelessWidget {
  final Agent agent;
  final AgentCustomization customization;

  const AgentOptionsSheet({
    super.key,
    required this.agent,
    required this.customization,
  });

  static Future<AgentOption?> show(
    BuildContext context, {
    required Agent agent,
    required AgentCustomization customization,
  }) {
    HapticFeedback.mediumImpact();
    return showModalBottomSheet<AgentOption>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (_) => AgentOptionsSheet(
        agent: agent,
        customization: customization,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final displayName = customization.customName ?? agent.displayName;
    final isFav = customization.isFavorite;

    return Container(
      decoration: const BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Handle
            Center(
              child: Container(
                margin: const EdgeInsets.only(top: 12, bottom: 8),
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: AppColors.surfaceLight,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),

            // Agent header
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 20,
                    backgroundColor: agent.modelColor.withOpacity(0.15),
                    child: customization.iconCodePoint != null
                        ? Icon(
                            IconData(
                              customization.iconCodePoint!,
                              fontFamily: customization.iconFontFamily ??
                                  'MaterialIcons',
                            ),
                            color: agent.modelColor,
                            size: 22,
                          )
                        : Text(
                            displayName.isNotEmpty
                                ? displayName[0].toUpperCase()
                                : '?',
                            style: TextStyle(
                              color: agent.modelColor,
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          displayName,
                          style: const TextStyle(
                            color: AppColors.textPrimary,
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          agent.id,
                          style: const TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),

            const Divider(color: AppColors.surfaceLight, height: 1),
            const SizedBox(height: 4),

            _OptionTile(
              icon: isFav ? Icons.star : Icons.star_outline,
              iconColor: isFav ? Colors.amber : AppColors.textSecondary,
              title: isFav ? 'Remove from Favorites' : 'Add to Favorites',
              onTap: () => Navigator.pop(context, AgentOption.toggleFavorite),
            ),
            _OptionTile(
              icon: Icons.edit,
              iconColor: AppColors.accent,
              title: 'Rename Agent',
              onTap: () => Navigator.pop(context, AgentOption.rename),
            ),
            _OptionTile(
              icon: Icons.emoji_emotions,
              iconColor: AppColors.modelSonnet,
              title: 'Choose Icon',
              onTap: () => Navigator.pop(context, AgentOption.pickIcon),
            ),
            _OptionTile(
              icon: Icons.info_outline,
              iconColor: AppColors.textSecondary,
              title: 'View Details',
              onTap: () => Navigator.pop(context, AgentOption.viewDetails),
            ),

            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }
}

class _OptionTile extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String title;
  final VoidCallback onTap;

  const _OptionTile({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon, color: iconColor, size: 22),
      title: Text(
        title,
        style: const TextStyle(
          color: AppColors.textPrimary,
          fontSize: 15,
        ),
      ),
      onTap: onTap,
      dense: true,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 20),
    );
  }
}
