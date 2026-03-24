import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/agents/agents_provider.dart';

class CreateAgentScreen extends ConsumerStatefulWidget {
  const CreateAgentScreen({super.key});

  @override
  ConsumerState<CreateAgentScreen> createState() => _CreateAgentScreenState();
}

class _CreateAgentScreenState extends ConsumerState<CreateAgentScreen> {
  final _formKey = GlobalKey<FormState>();
  final _pageController = PageController();
  int _currentStep = 0;
  bool _isCreating = false;

  // Step 1: Basic Info
  final _idController = TextEditingController();
  final _displayNameController = TextEditingController();
  String _selectedModel = 'claude-sonnet-4-20250514';

  // Step 2: Telegram Config
  final _telegramAccountController = TextEditingController();
  final _botTokenController = TextEditingController();

  // Step 3: Identity & Workspace
  final _workspaceController = TextEditingController();
  final _identityController = TextEditingController();

  static const _models = [
    (
      id: 'claude-opus-4-20250514',
      name: 'Claude Opus 4',
      desc: 'Most capable. Deep analysis, complex reasoning.',
      color: AppColors.modelOpus,
    ),
    (
      id: 'claude-sonnet-4-20250514',
      name: 'Claude Sonnet 4',
      desc: 'Best balance of speed and intelligence.',
      color: AppColors.modelSonnet,
    ),
    (
      id: 'claude-haiku-3-20250307',
      name: 'Claude Haiku 3',
      desc: 'Fastest responses. Great for simple tasks.',
      color: AppColors.modelHaiku,
    ),
  ];

  static const _stepTitles = ['Basic Info', 'Telegram', 'Identity'];

  @override
  void dispose() {
    _pageController.dispose();
    _idController.dispose();
    _displayNameController.dispose();
    _telegramAccountController.dispose();
    _botTokenController.dispose();
    _workspaceController.dispose();
    _identityController.dispose();
    super.dispose();
  }

  String? _validateId(String? value) {
    if (value == null || value.trim().isEmpty) return 'Agent ID is required';
    final kebab = RegExp(r'^[a-z0-9]+(-[a-z0-9]+)*$');
    if (!kebab.hasMatch(value.trim())) {
      return 'Use lowercase letters, numbers, and hyphens (kebab-case)';
    }
    return null;
  }

  String? _validateBotToken(String? value) {
    if (value == null || value.trim().isEmpty) return null; // Optional
    final tokenRegex = RegExp(r'^\d+:[A-Za-z0-9_-]{35,}$');
    if (!tokenRegex.hasMatch(value.trim())) {
      return 'Invalid bot token format (should be like 123456:ABC-DEF...)';
    }
    return null;
  }

  void _nextStep() {
    if (_currentStep == 0) {
      if (_validateId(_idController.text) != null) {
        // Trigger validation display
        _formKey.currentState?.validate();
        return;
      }
    }
    if (_currentStep == 1) {
      if (_validateBotToken(_botTokenController.text) != null) {
        _formKey.currentState?.validate();
        return;
      }
    }

    if (_currentStep < 2) {
      HapticFeedback.lightImpact();
      setState(() => _currentStep++);
      _pageController.animateToPage(
        _currentStep,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeInOut,
      );
    }
  }

  void _prevStep() {
    if (_currentStep > 0) {
      HapticFeedback.lightImpact();
      setState(() => _currentStep--);
      _pageController.animateToPage(
        _currentStep,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeInOut,
      );
    }
  }

  Future<void> _create() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isCreating = true);

    try {
      final id = _idController.text.trim();
      await ref.read(agentsProvider.notifier).createAgent(
            id: id,
            telegramAccount:
                _telegramAccountController.text.trim().isNotEmpty
                    ? _telegramAccountController.text.trim()
                    : null,
            model: _selectedModel,
            workspace: _workspaceController.text.trim().isNotEmpty
                ? _workspaceController.text.trim()
                : null,
          );

      if (mounted) {
        HapticFeedback.heavyImpact();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Agent "$id" created successfully')),
        );
        context.pop();
      }
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
    return Scaffold(
      appBar: AppBar(
        title: const Text('Create Agent'),
      ),
      body: Form(
        key: _formKey,
        child: Column(
          children: [
            // Step indicator
            _StepIndicator(
              currentStep: _currentStep,
              titles: _stepTitles,
            ),

            // Pages
            Expanded(
              child: PageView(
                controller: _pageController,
                physics: const NeverScrollableScrollPhysics(),
                children: [
                  _buildBasicInfoStep(),
                  _buildTelegramStep(),
                  _buildIdentityStep(),
                ],
              ),
            ),

            // Navigation buttons
            SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    if (_currentStep > 0)
                      Expanded(
                        child: OutlinedButton(
                          onPressed: _prevStep,
                          style: OutlinedButton.styleFrom(
                            side: const BorderSide(
                                color: AppColors.surfaceLight),
                            padding: const EdgeInsets.symmetric(vertical: 14),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                          ),
                          child: const Text(
                            'Back',
                            style: TextStyle(color: AppColors.textPrimary),
                          ),
                        ),
                      ),
                    if (_currentStep > 0) const SizedBox(width: 12),
                    Expanded(
                      flex: 2,
                      child: ElevatedButton(
                        onPressed: _isCreating
                            ? null
                            : (_currentStep < 2 ? _nextStep : _create),
                        child: _isCreating
                            ? const SizedBox(
                                height: 20,
                                width: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : Text(
                                _currentStep < 2
                                    ? 'Next'
                                    : 'Create Agent'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBasicInfoStep() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const _StepTitle(
          title: 'Basic Information',
          subtitle: 'Set up the core identity of your agent',
        ),
        const SizedBox(height: 20),

        // Agent ID
        TextFormField(
          controller: _idController,
          style: const TextStyle(color: AppColors.textPrimary),
          decoration: const InputDecoration(
            labelText: 'Agent ID *',
            labelStyle: TextStyle(color: AppColors.textSecondary),
            hintText: 'e.g. my-agent',
            prefixIcon: Icon(Icons.tag, color: AppColors.textSecondary),
          ),
          validator: _validateId,
          textInputAction: TextInputAction.next,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[a-z0-9-]')),
          ],
        ),
        const SizedBox(height: 16),

        // Display Name
        TextFormField(
          controller: _displayNameController,
          style: const TextStyle(color: AppColors.textPrimary),
          decoration: const InputDecoration(
            labelText: 'Display Name',
            labelStyle: TextStyle(color: AppColors.textSecondary),
            hintText: 'Optional friendly name',
            prefixIcon:
                Icon(Icons.badge_outlined, color: AppColors.textSecondary),
          ),
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 24),

        // Model selector
        const Text(
          'AI Model',
          style: TextStyle(
            color: AppColors.textSecondary,
            fontSize: 12,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.5,
          ),
        ),
        const SizedBox(height: 8),
        ...List.generate(_models.length, (i) {
          final model = _models[i];
          final isSelected = _selectedModel == model.id;
          return GestureDetector(
            onTap: () {
              HapticFeedback.selectionClick();
              setState(() => _selectedModel = model.id);
            },
            child: Container(
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: isSelected
                    ? model.color.withOpacity(0.1)
                    : AppColors.surfaceLight,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: isSelected
                      ? model.color.withOpacity(0.5)
                      : AppColors.surfaceLight,
                  width: isSelected ? 1.5 : 1,
                ),
              ),
              child: Row(
                children: [
                  Container(
                    width: 20,
                    height: 20,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: isSelected ? model.color : Colors.transparent,
                      border: Border.all(
                        color: isSelected
                            ? model.color
                            : AppColors.textSecondary,
                        width: 2,
                      ),
                    ),
                    child: isSelected
                        ? const Icon(Icons.check,
                            color: Colors.white, size: 14)
                        : null,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          model.name,
                          style: TextStyle(
                            color: isSelected
                                ? model.color
                                : AppColors.textPrimary,
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          model.desc,
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
          );
        }),
      ],
    );
  }

  Widget _buildTelegramStep() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const _StepTitle(
          title: 'Telegram Configuration',
          subtitle: 'Connect your agent to Telegram (optional)',
        ),
        const SizedBox(height: 20),

        TextFormField(
          controller: _telegramAccountController,
          style: const TextStyle(color: AppColors.textPrimary),
          decoration: const InputDecoration(
            labelText: 'Telegram Account',
            labelStyle: TextStyle(color: AppColors.textSecondary),
            hintText: 'e.g. @myagent_bot',
            prefixIcon: Icon(Icons.telegram, color: AppColors.textSecondary),
          ),
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 16),

        TextFormField(
          controller: _botTokenController,
          style: const TextStyle(color: AppColors.textPrimary),
          decoration: const InputDecoration(
            labelText: 'Bot Token',
            labelStyle: TextStyle(color: AppColors.textSecondary),
            hintText: '123456789:ABCDEF...',
            prefixIcon: Icon(Icons.key, color: AppColors.textSecondary),
          ),
          validator: _validateBotToken,
          textInputAction: TextInputAction.done,
          obscureText: true,
        ),
        const SizedBox(height: 16),

        // Info card
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.info.withOpacity(0.08),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: AppColors.info.withOpacity(0.2),
              width: 1,
            ),
          ),
          child: const Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.info_outline, color: AppColors.info, size: 18),
              SizedBox(width: 10),
              Expanded(
                child: Text(
                  'You can get a bot token from @BotFather on Telegram. '
                  'The token connects your agent to its Telegram bot.',
                  style: TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildIdentityStep() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const _StepTitle(
          title: 'Identity & Workspace',
          subtitle: 'Define what your agent knows and where it works',
        ),
        const SizedBox(height: 20),

        TextFormField(
          controller: _workspaceController,
          style: const TextStyle(color: AppColors.textPrimary),
          decoration: InputDecoration(
            labelText: 'Workspace Path',
            labelStyle: const TextStyle(color: AppColors.textSecondary),
            hintText:
                '/root/claude-agents/agents/${_idController.text.isNotEmpty ? _idController.text : '{id}'}',
            prefixIcon:
                const Icon(Icons.folder_outlined, color: AppColors.textSecondary),
          ),
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 16),

        // Identity template
        const Text(
          'IDENTITY.md Template',
          style: TextStyle(
            color: AppColors.textSecondary,
            fontSize: 12,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.5,
          ),
        ),
        const SizedBox(height: 8),
        TextFormField(
          controller: _identityController,
          style: const TextStyle(
            color: AppColors.textPrimary,
            fontFamily: 'monospace',
            fontSize: 13,
            height: 1.5,
          ),
          maxLines: 12,
          decoration: InputDecoration(
            hintText:
                '# Agent Identity\n\nYou are a helpful assistant...\n\n## Capabilities\n- ...',
            hintStyle: TextStyle(
              color: AppColors.textSecondary.withOpacity(0.5),
              fontFamily: 'monospace',
              fontSize: 13,
            ),
            filled: true,
            fillColor: AppColors.codeBackground,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: AppColors.surfaceLight),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: AppColors.surfaceLight),
            ),
            contentPadding: const EdgeInsets.all(14),
          ),
        ),
        const SizedBox(height: 16),

        // Summary card
        GlassCard(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Summary',
                style: TextStyle(
                  color: AppColors.textPrimary,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 8),
              _SummaryRow(
                  label: 'Agent ID',
                  value: _idController.text.isNotEmpty
                      ? _idController.text
                      : '--'),
              _SummaryRow(
                label: 'Model',
                value: _models
                    .firstWhere((m) => m.id == _selectedModel)
                    .name,
              ),
              if (_telegramAccountController.text.isNotEmpty)
                _SummaryRow(
                  label: 'Telegram',
                  value: _telegramAccountController.text,
                ),
              if (_workspaceController.text.isNotEmpty)
                _SummaryRow(
                  label: 'Workspace',
                  value: _workspaceController.text,
                ),
            ],
          ),
        ),
      ],
    );
  }
}

// ---------- Step indicator ----------

class _StepIndicator extends StatelessWidget {
  final int currentStep;
  final List<String> titles;

  const _StepIndicator({required this.currentStep, required this.titles});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(bottom: BorderSide(color: AppColors.surfaceLight)),
      ),
      child: Row(
        children: List.generate(titles.length * 2 - 1, (i) {
          if (i.isOdd) {
            // Connector line
            final stepBefore = i ~/ 2;
            return Expanded(
              child: Container(
                height: 2,
                margin: const EdgeInsets.symmetric(horizontal: 4),
                color: stepBefore < currentStep
                    ? AppColors.accent
                    : AppColors.surfaceLight,
              ),
            );
          }
          final step = i ~/ 2;
          final isActive = step == currentStep;
          final isCompleted = step < currentStep;

          return GestureDetector(
            onTap: step < currentStep
                ? () {
                    // Allow going back to completed steps
                  }
                : null,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    color: isCompleted
                        ? AppColors.accent
                        : isActive
                            ? AppColors.accent.withOpacity(0.15)
                            : AppColors.surfaceLight,
                    shape: BoxShape.circle,
                    border: isActive
                        ? Border.all(color: AppColors.accent, width: 2)
                        : null,
                  ),
                  child: Center(
                    child: isCompleted
                        ? const Icon(Icons.check,
                            color: Colors.white, size: 16)
                        : Text(
                            '${step + 1}',
                            style: TextStyle(
                              color: isActive
                                  ? AppColors.accent
                                  : AppColors.textSecondary,
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  titles[step],
                  style: TextStyle(
                    color: isActive || isCompleted
                        ? AppColors.textPrimary
                        : AppColors.textSecondary,
                    fontSize: 12,
                    fontWeight:
                        isActive ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
              ],
            ),
          );
        }),
      ),
    );
  }
}

// ---------- Step title ----------

class _StepTitle extends StatelessWidget {
  final String title;
  final String subtitle;

  const _StepTitle({required this.title, required this.subtitle});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(
            color: AppColors.textPrimary,
            fontSize: 18,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          subtitle,
          style: const TextStyle(
            color: AppColors.textSecondary,
            fontSize: 13,
          ),
        ),
      ],
    );
  }
}

// ---------- Summary row ----------

class _SummaryRow extends StatelessWidget {
  final String label;
  final String value;

  const _SummaryRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 80,
            child: Text(
              label,
              style: const TextStyle(
                color: AppColors.textSecondary,
                fontSize: 12,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(
                color: AppColors.textPrimary,
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
