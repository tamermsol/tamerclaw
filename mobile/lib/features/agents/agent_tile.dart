import 'package:flutter/material.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/shared/models/agent.dart';
import 'package:tamerclaw_mobile/shared/models/agent_customization.dart';

class AgentTile extends StatelessWidget {
  final Agent agent;
  final AgentCustomization customization;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final VoidCallback? onFavoriteToggle;

  const AgentTile({
    super.key,
    required this.agent,
    this.customization = const AgentCustomization(),
    required this.onTap,
    this.onLongPress,
    this.onFavoriteToggle,
  });

  String get _displayName =>
      customization.customName ?? agent.displayName;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              // Avatar with status dot and custom icon
              Stack(
                children: [
                  CircleAvatar(
                    radius: 22,
                    backgroundColor: agent.modelColor.withOpacity(0.15),
                    child: _buildAvatarContent(),
                  ),
                  Positioned(
                    right: 0,
                    bottom: 0,
                    child: Container(
                      width: 12,
                      height: 12,
                      decoration: BoxDecoration(
                        color: agent.isBusy
                            ? agent.activityColor
                            : agent.isActive
                                ? AppColors.online
                                : AppColors.offline,
                        shape: BoxShape.circle,
                        border:
                            Border.all(color: AppColors.surface, width: 2),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(width: 14),

              // Name + subtitle
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            _displayName,
                            style: const TextStyle(
                              color: AppColors.textPrimary,
                              fontSize: 15,
                              fontWeight: FontWeight.w500,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (customization.customName != null) ...[
                          const SizedBox(width: 6),
                          const Icon(
                            Icons.edit,
                            size: 10,
                            color: AppColors.textSecondary,
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 3),
                    if (agent.isBusy)
                      Row(
                        children: [
                          Container(
                            width: 6,
                            height: 6,
                            margin: const EdgeInsets.only(right: 4),
                            decoration: BoxDecoration(
                              color: agent.activityColor,
                              shape: BoxShape.circle,
                            ),
                          ),
                          Text(
                            agent.activityStatusLabel,
                            style: TextStyle(
                              color: agent.activityColor,
                              fontSize: 12,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      )
                    else
                      Text(
                        agent.isActive
                            ? agent.lastActivityText
                            : 'Offline',
                        style: TextStyle(
                          color: agent.isActive
                              ? AppColors.textSecondary
                              : AppColors.offline,
                          fontSize: 12,
                        ),
                      ),
                  ],
                ),
              ),

              // Favorite star
              if (onFavoriteToggle != null)
                GestureDetector(
                  onTap: onFavoriteToggle,
                  behavior: HitTestBehavior.opaque,
                  child: Padding(
                    padding: const EdgeInsets.all(4),
                    child: Icon(
                      customization.isFavorite
                          ? Icons.star
                          : Icons.star_outline,
                      color: customization.isFavorite
                          ? Colors.amber
                          : AppColors.textSecondary.withOpacity(0.4),
                      size: 22,
                    ),
                  ),
                ),

              const SizedBox(width: 4),

              // Model badge
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: agent.modelColor.withOpacity(0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  agent.modelBadge,
                  style: TextStyle(
                    color: agent.modelColor,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              const SizedBox(width: 4),
              const Icon(Icons.chevron_right,
                  color: AppColors.textSecondary, size: 20),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildAvatarContent() {
    // Custom icon from icon picker
    if (customization.iconCodePoint != null) {
      return Icon(
        IconData(
          customization.iconCodePoint!,
          fontFamily: customization.iconFontFamily ?? 'MaterialIcons',
        ),
        color: agent.modelColor,
        size: 22,
      );
    }

    // Default: first letter of display name
    return Text(
      _displayName.isNotEmpty ? _displayName[0].toUpperCase() : '?',
      style: TextStyle(
        color: agent.modelColor,
        fontSize: 18,
        fontWeight: FontWeight.w600,
      ),
    );
  }
}
