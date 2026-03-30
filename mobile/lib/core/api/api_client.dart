import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

/// Callback for when a 401 triggers a token refresh.
/// Returns the new token, or null if refresh failed.
typedef TokenRefresher = Future<String?> Function();

class ApiClient {
  final String baseUrl;
  String token;
  TokenRefresher? onTokenRefresh;

  ApiClient({required this.baseUrl, required this.token, this.onTokenRefresh});

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      };

  Uri _uri(String path) {
    final cleanBase =
        baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    final cleanPath = path.startsWith('/') ? path : '/$path';
    return Uri.parse('$cleanBase$cleanPath');
  }

  Future<dynamic> get(String path) => _withAutoRefresh(() async {
    try {
      final response = await http
          .get(_uri(path), headers: _headers)
          .timeout(const Duration(seconds: 15));
      return _handleResponse(response);
    } on TimeoutException {
      throw const ApiException('Request timed out. Check your server connection.');
    } on SocketException {
      throw const ApiException(
          'Cannot connect to server. Check your network and server URL.');
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException('Request failed: $e');
    }
  });

  Future<dynamic> post(String path, Map<String, dynamic> body) => _withAutoRefresh(() async {
    try {
      final response = await http
          .post(_uri(path), headers: _headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 60));
      return _handleResponse(response);
    } on TimeoutException {
      throw const ApiException(
          'Request timed out. The agent may still be processing.');
    } on SocketException {
      throw const ApiException('Cannot connect to server.');
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException('Request failed: $e');
    }
  });

  Future<dynamic> put(String path, Map<String, dynamic> body) => _withAutoRefresh(() async {
    try {
      final response = await http
          .put(_uri(path), headers: _headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 15));
      return _handleResponse(response);
    } on TimeoutException {
      throw const ApiException('Request timed out.');
    } on SocketException {
      throw const ApiException('Cannot connect to server.');
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException('Request failed: $e');
    }
  });

  Future<dynamic> postMultipart(
    String path,
    Map<String, String> fields,
    List<http.MultipartFile> files,
  ) => _withAutoRefresh(() async {
    try {
      final request = http.MultipartRequest('POST', _uri(path));
      request.headers['Authorization'] = 'Bearer $token';
      request.fields.addAll(fields);
      request.files.addAll(files);

      final streamedResponse =
          await request.send().timeout(const Duration(seconds: 180));
      final response = await http.Response.fromStream(streamedResponse)
          .timeout(const Duration(seconds: 180));
      return _handleResponse(response);
    } on TimeoutException {
      throw const ApiException(
          'Upload timed out. The server may be processing the message.');
    } on SocketException {
      throw const ApiException(
          'Cannot connect to server. Check your network connection.');
    } on http.ClientException {
      throw const ApiException(
          'Connection lost during upload. Check your network and try again.');
    } on ApiException {
      rethrow;
    } catch (e) {
      // Catch any other connection/IO errors that slip through
      final msg = e.toString().toLowerCase();
      if (msg.contains('connection') || msg.contains('abort') || msg.contains('reset')) {
        throw const ApiException(
            'Connection lost during upload. Check your network and try again.');
      }
      throw ApiException('Upload failed: $e');
    }
  });

  /// POST that returns raw bytes (for TTS audio, file downloads, etc.)
  Future<List<int>?> postRaw(String path, Map<String, dynamic> body) => _withAutoRefresh(() async {
    try {
      final response = await http
          .post(_uri(path), headers: _headers, body: jsonEncode(body))
          .timeout(const Duration(seconds: 60));
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return response.bodyBytes;
      } else if (response.statusCode == 401) {
        throw const ApiUnauthorizedException('Unauthorized.');
      }
      return null;
    } on TimeoutException {
      return null;
    } on SocketException {
      return null;
    } on ApiException {
      rethrow;
    } catch (_) {
      return null;
    }
  }) as Future<List<int>?>;

  Future<dynamic> delete(String path) => _withAutoRefresh(() async {
    try {
      final response = await http
          .delete(_uri(path), headers: _headers)
          .timeout(const Duration(seconds: 15));
      return _handleResponse(response);
    } on TimeoutException {
      throw const ApiException('Request timed out.');
    } on SocketException {
      throw const ApiException('Cannot connect to server.');
    } on ApiException {
      rethrow;
    } catch (e) {
      throw ApiException('Request failed: $e');
    }
  });

  dynamic _handleResponse(http.Response response) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (response.body.isEmpty) return <String, dynamic>{};
      final decoded = jsonDecode(response.body);
      if (decoded is List) return decoded;
      return decoded as Map<String, dynamic>;
    } else if (response.statusCode == 401) {
      throw const ApiUnauthorizedException('Unauthorized. Please log in again.');
    } else if (response.statusCode == 404) {
      throw const ApiException('Not found.');
    } else {
      String message = 'Server error (${response.statusCode})';
      try {
        final body = jsonDecode(response.body);
        if (body is Map) {
          message = (body['error'] ?? body['message'] ?? message).toString();
        }
      } catch (_) {}
      throw ApiException(message);
    }
  }

  /// Wrap a request with automatic token refresh on 401.
  Future<dynamic> _withAutoRefresh(Future<dynamic> Function() request) async {
    try {
      return await request();
    } on ApiUnauthorizedException {
      // Try to refresh token
      if (onTokenRefresh != null) {
        final newToken = await onTokenRefresh!();
        if (newToken != null) {
          token = newToken;
          // Retry with new token
          return await request();
        }
      }
      throw const ApiException('Unauthorized. Please log in again.');
    }
  }

  static Future<Map<String, dynamic>> login({
    required String serverUrl,
    required String username,
    required String password,
  }) async {
    final cleanUrl = serverUrl.endsWith('/')
        ? serverUrl.substring(0, serverUrl.length - 1)
        : serverUrl;
    try {
      final response = await http
          .post(
            Uri.parse('$cleanUrl/api/auth/login'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'username': username, 'password': password}),
          )
          .timeout(const Duration(seconds: 15));

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return jsonDecode(response.body) as Map<String, dynamic>;
      } else if (response.statusCode == 401) {
        throw const ApiException('Invalid username or password.');
      } else {
        String message = 'Login failed (${response.statusCode})';
        try {
          final body = jsonDecode(response.body);
          if (body is Map && body['error'] != null) {
            message = body['error'].toString();
          }
        } catch (_) {}
        throw ApiException(message);
      }
    } on TimeoutException {
      throw const ApiException('Connection timed out. Is the server running?');
    } on SocketException {
      throw const ApiException(
          'Cannot connect to server. Check the URL and your network.');
    } on http.ClientException {
      throw const ApiException('Connection failed. Is the server running?');
    } on FormatException {
      throw const ApiException('Invalid server URL format.');
    } catch (e) {
      if (e is ApiException) rethrow;
      throw ApiException('Connection error: $e');
    }
  }

  /// Quick health check -- no auth needed.
  static Future<bool> checkHealth(String serverUrl) async {
    final cleanUrl = serverUrl.endsWith('/')
        ? serverUrl.substring(0, serverUrl.length - 1)
        : serverUrl;
    try {
      final response = await http
          .get(Uri.parse('$cleanUrl/api/health'))
          .timeout(const Duration(seconds: 5));
      return response.statusCode >= 200 && response.statusCode < 300;
    } catch (_) {
      return false;
    }
  }
}

class ApiException implements Exception {
  final String message;
  const ApiException(this.message);

  @override
  String toString() => message;
}

/// Specific 401 exception for auto-refresh logic.
class ApiUnauthorizedException extends ApiException {
  const ApiUnauthorizedException(super.message);
}
