import 'package:flutter/material.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';

/// A large, searchable icon picker dialog with hundreds of Material icons
/// organized by category.
class IconPickerDialog extends StatefulWidget {
  /// Sentinel value returned when the user taps "Reset to Default".
  /// Callers should check for this to distinguish reset from dismiss (null).
  static const resetSentinel = IconData(0);

  final IconData? currentIcon;

  const IconPickerDialog({super.key, this.currentIcon});

  /// Show the icon picker and return the chosen icon, or null if cancelled.
  static Future<IconData?> show(BuildContext context,
      {IconData? currentIcon}) {
    return showModalBottomSheet<IconData>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => IconPickerDialog(currentIcon: currentIcon),
    );
  }

  @override
  State<IconPickerDialog> createState() => _IconPickerDialogState();
}

class _IconPickerDialogState extends State<IconPickerDialog> {
  String _search = '';
  String _selectedCategory = 'All';

  static const _categories = <String, List<_NamedIcon>>{
    'Robots & AI': _aiIcons,
    'Animals': _animalIcons,
    'Symbols': _symbolIcons,
    'Science': _scienceIcons,
    'Nature': _natureIcons,
    'Objects': _objectIcons,
    'Transport': _transportIcons,
    'Sports': _sportsIcons,
    'Social': _socialIcons,
    'Misc': _miscIcons,
  };

  List<_NamedIcon> get _filteredIcons {
    List<_NamedIcon> source;
    if (_selectedCategory == 'All') {
      source = _categories.values.expand((e) => e).toList();
    } else {
      source = _categories[_selectedCategory] ?? [];
    }

    if (_search.isEmpty) return source;
    final query = _search.toLowerCase();
    return source.where((i) => i.name.toLowerCase().contains(query)).toList();
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _filteredIcons;
    final screenHeight = MediaQuery.of(context).size.height;

    return Container(
      height: screenHeight * 0.75,
      decoration: const BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: Column(
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

          // Title
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: Text(
              'Choose an Icon',
              style: TextStyle(
                color: AppColors.textPrimary,
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),

          // Search
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: TextField(
              style: const TextStyle(color: AppColors.textPrimary),
              decoration: InputDecoration(
                hintText: 'Search icons...',
                prefixIcon:
                    const Icon(Icons.search, color: AppColors.textSecondary),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 10),
                suffixIcon: _search.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear,
                            color: AppColors.textSecondary, size: 18),
                        onPressed: () => setState(() => _search = ''),
                      )
                    : null,
              ),
              onChanged: (v) => setState(() => _search = v),
            ),
          ),

          // Category chips
          SizedBox(
            height: 40,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                _categoryChip('All'),
                ..._categories.keys.map(_categoryChip),
              ],
            ),
          ),
          const SizedBox(height: 8),

          // Clear icon button
          if (widget.currentIcon != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: SizedBox(
                width: double.infinity,
                child: TextButton.icon(
                  onPressed: () =>
                      Navigator.pop(context, IconPickerDialog.resetSentinel),
                  icon: const Icon(Icons.clear, size: 16),
                  label: const Text('Reset to Default'),
                  style: TextButton.styleFrom(
                    foregroundColor: AppColors.textSecondary,
                  ),
                ),
              ),
            ),

          // Icon grid
          Expanded(
            child: filtered.isEmpty
                ? const Center(
                    child: Text(
                      'No icons found',
                      style: TextStyle(color: AppColors.textSecondary),
                    ),
                  )
                : GridView.builder(
                    padding: const EdgeInsets.all(12),
                    gridDelegate:
                        const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 5,
                      mainAxisSpacing: 8,
                      crossAxisSpacing: 8,
                    ),
                    itemCount: filtered.length,
                    itemBuilder: (context, index) {
                      final item = filtered[index];
                      final isSelected =
                          widget.currentIcon?.codePoint == item.icon.codePoint;
                      return Tooltip(
                        message: item.name,
                        child: InkWell(
                          onTap: () => Navigator.pop(context, item.icon),
                          borderRadius: BorderRadius.circular(12),
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 150),
                            decoration: BoxDecoration(
                              color: isSelected
                                  ? AppColors.accent.withOpacity(0.2)
                                  : AppColors.surfaceLight.withOpacity(0.4),
                              borderRadius: BorderRadius.circular(12),
                              border: isSelected
                                  ? Border.all(
                                      color: AppColors.accent, width: 2)
                                  : null,
                            ),
                            child: Icon(
                              item.icon,
                              color: isSelected
                                  ? AppColors.accent
                                  : AppColors.textPrimary,
                              size: 26,
                            ),
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Widget _categoryChip(String label) {
    final isSelected = _selectedCategory == label;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: ChoiceChip(
        label: Text(label, style: const TextStyle(fontSize: 12)),
        selected: isSelected,
        onSelected: (_) => setState(() => _selectedCategory = label),
        selectedColor: AppColors.accent.withOpacity(0.2),
        backgroundColor: AppColors.surfaceLight,
        labelStyle: TextStyle(
          color: isSelected ? AppColors.accent : AppColors.textSecondary,
          fontWeight: isSelected ? FontWeight.w600 : FontWeight.w400,
        ),
        side: BorderSide(
          color: isSelected ? AppColors.accent : Colors.transparent,
        ),
        visualDensity: VisualDensity.compact,
      ),
    );
  }
}

class _NamedIcon {
  final String name;
  final IconData icon;
  const _NamedIcon(this.name, this.icon);
}

// ===== Icon library organized by category =====

const _aiIcons = <_NamedIcon>[
  _NamedIcon('Robot', Icons.smart_toy),
  _NamedIcon('Robot Outlined', Icons.smart_toy_outlined),
  _NamedIcon('Hub', Icons.hub),
  _NamedIcon('Memory', Icons.memory),
  _NamedIcon('Psychology', Icons.psychology),
  _NamedIcon('Psychology Alt', Icons.psychology_alt),
  _NamedIcon('Brain', Icons.psychology_alt),
  _NamedIcon('Auto Fix', Icons.auto_fix_high),
  _NamedIcon('Auto Awesome', Icons.auto_awesome),
  _NamedIcon('Lightbulb', Icons.lightbulb),
  _NamedIcon('Tips & Updates', Icons.tips_and_updates),
  _NamedIcon('Terminal', Icons.terminal),
  _NamedIcon('Code', Icons.code),
  _NamedIcon('Developer Board', Icons.developer_board),
  _NamedIcon('Precision Mfg', Icons.precision_manufacturing),
  _NamedIcon('Computer', Icons.computer),
  _NamedIcon('Desktop', Icons.desktop_windows),
  _NamedIcon('Laptop', Icons.laptop_mac),
  _NamedIcon('Smartphone', Icons.smartphone),
  _NamedIcon('Cloud', Icons.cloud),
  _NamedIcon('Data Object', Icons.data_object),
  _NamedIcon('Api', Icons.api),
  _NamedIcon('Dns', Icons.dns),
  _NamedIcon('Storage', Icons.storage),
  _NamedIcon('Lan', Icons.lan),
  _NamedIcon('Router', Icons.router),
  _NamedIcon('Token', Icons.token),
  _NamedIcon('Integration', Icons.integration_instructions),
  _NamedIcon('Bug Report', Icons.bug_report),
  _NamedIcon('Build', Icons.build),
];

const _animalIcons = <_NamedIcon>[
  _NamedIcon('Pets', Icons.pets),
  _NamedIcon('Cruelty Free', Icons.cruelty_free),
  _NamedIcon('Pest Control', Icons.pest_control),
  _NamedIcon('Bug', Icons.bug_report),
  _NamedIcon('Hive', Icons.hive),
  _NamedIcon('Phishing', Icons.phishing),
  _NamedIcon('Egg', Icons.egg),
  _NamedIcon('Egg Alt', Icons.egg_alt),
  _NamedIcon('Set Meal', Icons.set_meal),
  _NamedIcon('Kebab Dining', Icons.kebab_dining),
  _NamedIcon('Catching Pokemon', Icons.catching_pokemon),
];

const _symbolIcons = <_NamedIcon>[
  _NamedIcon('Star', Icons.star),
  _NamedIcon('Star Half', Icons.star_half),
  _NamedIcon('Favorite', Icons.favorite),
  _NamedIcon('Diamond', Icons.diamond),
  _NamedIcon('Hexagon', Icons.hexagon),
  _NamedIcon('Pentagon', Icons.pentagon),
  _NamedIcon('Circle', Icons.circle),
  _NamedIcon('Square', Icons.square),
  _NamedIcon('Change History', Icons.change_history),
  _NamedIcon('All Inclusive', Icons.all_inclusive),
  _NamedIcon('Infinity', Icons.all_inclusive),
  _NamedIcon('Bolt', Icons.bolt),
  _NamedIcon('Flash On', Icons.flash_on),
  _NamedIcon('Whatshot', Icons.whatshot),
  _NamedIcon('Local Fire', Icons.local_fire_department),
  _NamedIcon('Flare', Icons.flare),
  _NamedIcon('Grade', Icons.grade),
  _NamedIcon('Shield', Icons.shield),
  _NamedIcon('Verified', Icons.verified),
  _NamedIcon('Workspace Premium', Icons.workspace_premium),
  _NamedIcon('Military Tech', Icons.military_tech),
  _NamedIcon('Emoji Events', Icons.emoji_events),
  _NamedIcon('Crown', Icons.workspace_premium),
  _NamedIcon('Bookmark', Icons.bookmark),
  _NamedIcon('Flag', Icons.flag),
  _NamedIcon('Anchor', Icons.anchor),
  _NamedIcon('Brightness 7', Icons.brightness_7),
  _NamedIcon('Adjust', Icons.adjust),
  _NamedIcon('Lens', Icons.lens),
  _NamedIcon('Key', Icons.key),
  _NamedIcon('Lock', Icons.lock),
  _NamedIcon('Fingerprint', Icons.fingerprint),
  _NamedIcon('Visibility', Icons.visibility),
];

const _scienceIcons = <_NamedIcon>[
  _NamedIcon('Science', Icons.science),
  _NamedIcon('Biotech', Icons.biotech),
  _NamedIcon('Rocket', Icons.rocket_launch),
  _NamedIcon('Satellite', Icons.satellite_alt),
  _NamedIcon('Public', Icons.public),
  _NamedIcon('Language', Icons.language),
  _NamedIcon('Explore', Icons.explore),
  _NamedIcon('Radar', Icons.radar),
  _NamedIcon('Thermostat', Icons.thermostat),
  _NamedIcon('Waves', Icons.waves),
  _NamedIcon('Air', Icons.air),
  _NamedIcon('Cyclone', Icons.cyclone),
  _NamedIcon('Bolt', Icons.electric_bolt),
  _NamedIcon('Battery', Icons.battery_full),
  _NamedIcon('Solar Power', Icons.solar_power),
  _NamedIcon('Wind Power', Icons.wind_power),
  _NamedIcon('Calculate', Icons.calculate),
  _NamedIcon('Functions', Icons.functions),
  _NamedIcon('Architecture', Icons.architecture),
  _NamedIcon('Analytics', Icons.analytics),
];

const _natureIcons = <_NamedIcon>[
  _NamedIcon('Park', Icons.park),
  _NamedIcon('Forest', Icons.forest),
  _NamedIcon('Grass', Icons.grass),
  _NamedIcon('Eco', Icons.eco),
  _NamedIcon('Yard', Icons.yard),
  _NamedIcon('Terrain', Icons.terrain),
  _NamedIcon('Landscape', Icons.landscape),
  _NamedIcon('Mountain', Icons.filter_hdr),
  _NamedIcon('Water', Icons.water),
  _NamedIcon('Water Drop', Icons.water_drop),
  _NamedIcon('Ac Unit', Icons.ac_unit),
  _NamedIcon('Sunny', Icons.wb_sunny),
  _NamedIcon('Cloudy', Icons.cloud),
  _NamedIcon('Thunderstorm', Icons.thunderstorm),
  _NamedIcon('Rainbow', Icons.looks),
  _NamedIcon('Dark Mode', Icons.dark_mode),
  _NamedIcon('Light Mode', Icons.light_mode),
  _NamedIcon('Nights Stay', Icons.nights_stay),
  _NamedIcon('Spa', Icons.spa),
  _NamedIcon('Compost', Icons.compost),
];

const _objectIcons = <_NamedIcon>[
  _NamedIcon('Camera', Icons.camera_alt),
  _NamedIcon('Photo', Icons.photo_camera),
  _NamedIcon('Headset', Icons.headset),
  _NamedIcon('Headphones', Icons.headphones),
  _NamedIcon('Mic', Icons.mic),
  _NamedIcon('Music Note', Icons.music_note),
  _NamedIcon('Piano', Icons.piano),
  _NamedIcon('Gamepad', Icons.gamepad),
  _NamedIcon('Sports Esports', Icons.sports_esports),
  _NamedIcon('Casino', Icons.casino),
  _NamedIcon('Extension', Icons.extension),
  _NamedIcon('Palette', Icons.palette),
  _NamedIcon('Brush', Icons.brush),
  _NamedIcon('Draw', Icons.draw),
  _NamedIcon('Edit', Icons.edit),
  _NamedIcon('Create', Icons.create),
  _NamedIcon('Book', Icons.menu_book),
  _NamedIcon('Library', Icons.local_library),
  _NamedIcon('School', Icons.school),
  _NamedIcon('Cake', Icons.cake),
  _NamedIcon('Coffee', Icons.coffee),
  _NamedIcon('Restaurant', Icons.restaurant),
  _NamedIcon('Pizza', Icons.local_pizza),
  _NamedIcon('Icecream', Icons.icecream),
  _NamedIcon('Wine Bar', Icons.wine_bar),
  _NamedIcon('Nightlife', Icons.nightlife),
  _NamedIcon('Celebration', Icons.celebration),
  _NamedIcon('Gift', Icons.card_giftcard),
  _NamedIcon('Shopping Bag', Icons.shopping_bag),
  _NamedIcon('Watch', Icons.watch),
];

const _transportIcons = <_NamedIcon>[
  _NamedIcon('Flight', Icons.flight),
  _NamedIcon('Directions Car', Icons.directions_car),
  _NamedIcon('Motorcycle', Icons.two_wheeler),
  _NamedIcon('Directions Bike', Icons.directions_bike),
  _NamedIcon('Directions Run', Icons.directions_run),
  _NamedIcon('Train', Icons.train),
  _NamedIcon('Subway', Icons.subway),
  _NamedIcon('Directions Boat', Icons.directions_boat),
  _NamedIcon('Sailing', Icons.sailing),
  _NamedIcon('Paragliding', Icons.paragliding),
  _NamedIcon('Snowboarding', Icons.snowboarding),
  _NamedIcon('Skateboarding', Icons.skateboarding),
  _NamedIcon('Electric Car', Icons.electric_car),
  _NamedIcon('Local Shipping', Icons.local_shipping),
  _NamedIcon('Rocket', Icons.rocket),
];

const _sportsIcons = <_NamedIcon>[
  _NamedIcon('Fitness Center', Icons.fitness_center),
  _NamedIcon('Sports Martial Arts', Icons.sports_martial_arts),
  _NamedIcon('Sports Soccer', Icons.sports_soccer),
  _NamedIcon('Sports Basketball', Icons.sports_basketball),
  _NamedIcon('Sports Tennis', Icons.sports_tennis),
  _NamedIcon('Sports Golf', Icons.sports_golf),
  _NamedIcon('Pool', Icons.pool),
  _NamedIcon('Surfing', Icons.surfing),
  _NamedIcon('Hiking', Icons.hiking),
  _NamedIcon('Downhill Skiing', Icons.downhill_skiing),
  _NamedIcon('Sports Score', Icons.sports_score),
  _NamedIcon('Scoreboard', Icons.scoreboard),
  _NamedIcon('Emoji Events', Icons.emoji_events),
  _NamedIcon('Leaderboard', Icons.leaderboard),
  _NamedIcon('Self Improvement', Icons.self_improvement),
];

const _socialIcons = <_NamedIcon>[
  _NamedIcon('Person', Icons.person),
  _NamedIcon('Group', Icons.group),
  _NamedIcon('Groups', Icons.groups),
  _NamedIcon('Diversity 3', Icons.diversity_3),
  _NamedIcon('Face', Icons.face),
  _NamedIcon('Face 2', Icons.face_2),
  _NamedIcon('Face 3', Icons.face_3),
  _NamedIcon('Face 4', Icons.face_4),
  _NamedIcon('Face 5', Icons.face_5),
  _NamedIcon('Face 6', Icons.face_6),
  _NamedIcon('Emoji People', Icons.emoji_people),
  _NamedIcon('Waving Hand', Icons.waving_hand),
  _NamedIcon('Handshake', Icons.handshake),
  _NamedIcon('Mood', Icons.mood),
  _NamedIcon('Sentiment Satisfied', Icons.sentiment_satisfied),
  _NamedIcon('Sentiment Very Satisfied', Icons.sentiment_very_satisfied),
  _NamedIcon('Sentiment Neutral', Icons.sentiment_neutral),
  _NamedIcon('Chat', Icons.chat),
  _NamedIcon('Forum', Icons.forum),
  _NamedIcon('Support Agent', Icons.support_agent),
  _NamedIcon('Engineering', Icons.engineering),
  _NamedIcon('Manage Accounts', Icons.manage_accounts),
  _NamedIcon('Admin', Icons.admin_panel_settings),
  _NamedIcon('Supervisor', Icons.supervisor_account),
  _NamedIcon('Badge', Icons.badge),
];

const _miscIcons = <_NamedIcon>[
  _NamedIcon('Home', Icons.home),
  _NamedIcon('Work', Icons.work),
  _NamedIcon('Favorite', Icons.favorite),
  _NamedIcon('Notifications', Icons.notifications),
  _NamedIcon('Alarm', Icons.alarm),
  _NamedIcon('Timer', Icons.timer),
  _NamedIcon('Hourglass', Icons.hourglass_empty),
  _NamedIcon('Speed', Icons.speed),
  _NamedIcon('Compress', Icons.compress),
  _NamedIcon('Expand', Icons.expand),
  _NamedIcon('Tune', Icons.tune),
  _NamedIcon('Settings', Icons.settings),
  _NamedIcon('Construction', Icons.construction),
  _NamedIcon('Handyman', Icons.handyman),
  _NamedIcon('Plumbing', Icons.plumbing),
  _NamedIcon('Recycling', Icons.recycling),
  _NamedIcon('Cleaning', Icons.cleaning_services),
  _NamedIcon('Local Laundry', Icons.local_laundry_service),
  _NamedIcon('Restaurant Menu', Icons.restaurant_menu),
  _NamedIcon('Map', Icons.map),
  _NamedIcon('Place', Icons.place),
  _NamedIcon('My Location', Icons.my_location),
  _NamedIcon('Navigation', Icons.navigation),
  _NamedIcon('Compass', Icons.explore),
  _NamedIcon('Layers', Icons.layers),
  _NamedIcon('Stacked Line Chart', Icons.stacked_line_chart),
  _NamedIcon('Pie Chart', Icons.pie_chart),
  _NamedIcon('Show Chart', Icons.show_chart),
  _NamedIcon('Monitoring', Icons.timeline),
  _NamedIcon('Insights', Icons.insights),
];
