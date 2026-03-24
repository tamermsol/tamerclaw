import 'package:flutter/material.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';

class RenameAgentDialog extends StatefulWidget {
  final String currentName;
  final String agentId;

  const RenameAgentDialog({
    super.key,
    required this.currentName,
    required this.agentId,
  });

  /// Show the rename dialog and return the new name, or null if cancelled.
  /// Returns empty string to indicate "reset to default".
  static Future<String?> show(
    BuildContext context, {
    required String currentName,
    required String agentId,
  }) {
    return showDialog<String>(
      context: context,
      builder: (_) => RenameAgentDialog(
        currentName: currentName,
        agentId: agentId,
      ),
    );
  }

  @override
  State<RenameAgentDialog> createState() => _RenameAgentDialogState();
}

class _RenameAgentDialogState extends State<RenameAgentDialog> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.currentName);
    _controller.selection = TextSelection(
      baseOffset: 0,
      extentOffset: widget.currentName.length,
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      title: const Text(
        'Rename Agent',
        style: TextStyle(color: AppColors.textPrimary, fontSize: 18),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Agent ID: ${widget.agentId}',
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _controller,
            autofocus: true,
            style: const TextStyle(color: AppColors.textPrimary),
            decoration: const InputDecoration(
              hintText: 'Custom display name',
              isDense: true,
            ),
            textCapitalization: TextCapitalization.words,
            onSubmitted: (_) => _submit(),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, ''),
          child: const Text(
            'Reset Default',
            style: TextStyle(color: AppColors.textSecondary),
          ),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: _submit,
          child: const Text('Save'),
        ),
      ],
    );
  }

  void _submit() {
    final text = _controller.text.trim();
    Navigator.pop(context, text.isEmpty ? '' : text);
  }
}
