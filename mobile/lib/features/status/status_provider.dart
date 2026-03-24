import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tamerclaw_mobile/core/api/api_endpoints.dart';
import 'package:tamerclaw_mobile/features/auth/auth_provider.dart';
import 'package:tamerclaw_mobile/shared/models/cron_job.dart';
import 'package:tamerclaw_mobile/shared/models/system_status.dart';

final statusProvider =
    StateNotifierProvider<StatusNotifier, StatusState>((ref) {
  final api = ref.watch(apiClientProvider);
  final notifier = StatusNotifier(api);
  notifier.fetchAll();
  notifier.startAutoRefresh();

  ref.onDispose(() => notifier.stopAutoRefresh());
  return notifier;
});

class StatusState {
  final SystemStatus? status;
  final List<CronJob> cronJobs;
  final List<DeliveryItem> deliveryItems;
  final bool isLoading;
  final String? error;

  const StatusState({
    this.status,
    this.cronJobs = const [],
    this.deliveryItems = const [],
    this.isLoading = false,
    this.error,
  });

  StatusState copyWith({
    SystemStatus? status,
    List<CronJob>? cronJobs,
    List<DeliveryItem>? deliveryItems,
    bool? isLoading,
    String? error,
  }) {
    return StatusState(
      status: status ?? this.status,
      cronJobs: cronJobs ?? this.cronJobs,
      deliveryItems: deliveryItems ?? this.deliveryItems,
      isLoading: isLoading ?? this.isLoading,
      error: error,
    );
  }
}

class StatusNotifier extends StateNotifier<StatusState> {
  final dynamic _api;
  Timer? _timer;

  StatusNotifier(this._api) : super(const StatusState());

  void startAutoRefresh() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => fetchAll());
  }

  void stopAutoRefresh() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> fetchAll() async {
    if (_api == null) return;

    state = state.copyWith(isLoading: state.status == null, error: null);

    try {
      Future<dynamic> safeGet(String path) async {
        try {
          return await _api.get(path);
        } catch (_) {
          return <String, dynamic>{};
        }
      }

      final results = await Future.wait<dynamic>([
        safeGet(ApiEndpoints.status),
        safeGet(ApiEndpoints.health),
        safeGet(ApiEndpoints.cronJobs),
        safeGet(ApiEndpoints.deliveryQueue),
      ]);

      final statusJson = results[0] is Map<String, dynamic>
          ? results[0] as Map<String, dynamic>
          : <String, dynamic>{};
      final healthJson = results[1] is Map<String, dynamic>
          ? results[1] as Map<String, dynamic>
          : <String, dynamic>{};
      final cronJson = results[2];
      final deliveryJson = results[3];

      var systemStatus = SystemStatus.fromStatusJson(statusJson);

      final uptime = healthJson['uptime'];
      if (uptime is int) {
        systemStatus = systemStatus.withUptime(uptime);
      } else if (uptime is double) {
        systemStatus = systemStatus.withUptime(uptime.toInt());
      }

      List<CronJob> cronJobs = [];
      if (cronJson is List) {
        cronJobs = cronJson
            .whereType<Map<String, dynamic>>()
            .map((j) => CronJob.fromJson(j))
            .toList();
      } else if (cronJson is Map) {
        final jobsList = cronJson['jobs'] ?? cronJson['data'];
        if (jobsList is List) {
          cronJobs = jobsList
              .whereType<Map<String, dynamic>>()
              .map((j) => CronJob.fromJson(j))
              .toList();
        }
      }

      List<DeliveryItem> deliveryItems = [];
      if (deliveryJson is List) {
        deliveryItems = deliveryJson
            .whereType<Map<String, dynamic>>()
            .map((j) => DeliveryItem.fromJson(j))
            .toList();
      } else if (deliveryJson is Map) {
        final items =
            deliveryJson['items'] ?? deliveryJson['data'] ?? deliveryJson['queue'];
        if (items is List) {
          deliveryItems = items
              .whereType<Map<String, dynamic>>()
              .map((j) => DeliveryItem.fromJson(j))
              .toList();
        }
      }

      state = StatusState(
        status: systemStatus,
        cronJobs: cronJobs,
        deliveryItems: deliveryItems,
      );
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }

  Future<void> toggleCronJob(CronJob job) async {
    if (_api == null) return;

    try {
      await _api.put(
        ApiEndpoints.cronJob(job.id),
        {'enabled': !job.enabled},
      );
      await fetchAll();
    } catch (e) {
      state = state.copyWith(error: 'Failed to toggle job: $e');
    }
  }

  Future<void> deleteCronJob(String jobId) async {
    if (_api == null) return;

    try {
      await _api.delete(ApiEndpoints.cronJob(jobId));
      await fetchAll();
    } catch (e) {
      state = state.copyWith(error: 'Failed to delete job: $e');
    }
  }

  Future<void> createCronJob({
    required String agentId,
    required String name,
    required String schedule,
    String? message,
  }) async {
    if (_api == null) return;

    try {
      await _api.post(ApiEndpoints.cronJobs, {
        'agentId': agentId,
        'name': name,
        'schedule': schedule,
        if (message != null && message.isNotEmpty) 'message': message,
      });
      await fetchAll();
    } catch (e) {
      state = state.copyWith(error: 'Failed to create job: $e');
      rethrow;
    }
  }
}
