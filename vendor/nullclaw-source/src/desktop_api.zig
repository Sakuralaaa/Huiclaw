const std = @import("std");
const Config = @import("config.zig").Config;
const config_mod = @import("config.zig");
const skills_mod = @import("skills.zig");
const cron_mod = @import("cron.zig");
const version_mod = @import("version.zig");
const json_util = @import("json_util.zig");
const platform = @import("platform.zig");

pub const DesktopResponse = struct {
    status: []const u8,
    body: []const u8,
};

pub fn handle(
    allocator: std.mem.Allocator,
    method: []const u8,
    base_path: []const u8,
    body_opt: ?[]const u8,
    bearer: ?[]const u8,
    desktop_token: ?[]const u8,
    config_opt: ?*const Config,
) DesktopResponse {
    if (!std.mem.startsWith(u8, base_path, "/api/desktop/")) {
        return .{ .status = "404 Not Found", .body = "{\"error\":\"not found\"}" };
    }

    const token = desktop_token orelse return .{
        .status = "503 Service Unavailable",
        .body = "{\"error\":\"desktop api unavailable\"}",
    };
    if (bearer == null or !std.mem.eql(u8, bearer.?, token)) {
        return .{ .status = "401 Unauthorized", .body = "{\"error\":\"unauthorized\"}" };
    }

    const cfg = config_opt orelse return .{
        .status = "404 Not Found",
        .body = "{\"error\":\"not configured\"}",
    };

    if (std.mem.eql(u8, base_path, "/api/desktop/status")) {
        return expectGet(allocator, method, buildStatusJson, cfg, "status build failed");
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/summary")) {
        return expectGet(allocator, method, buildSummaryJson, cfg, "summary build failed");
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/environment")) {
        return expectGet(allocator, method, buildEnvironmentJson, cfg, "environment build failed");
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/agents")) {
        return expectGet(allocator, method, buildAgentsJson, cfg, "agents build failed");
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/skills")) {
        return expectGet(allocator, method, buildSkillsJson, cfg, "skills build failed");
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/providers")) {
        return expectGet(allocator, method, buildProvidersJson, cfg, "providers build failed");
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/cron/jobs")) {
        return expectGet(allocator, method, buildSchedulesJson, cfg, "schedules build failed");
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/channels")) {
        return expectGet(allocator, method, buildChannelsJson, cfg, "channels build failed");
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/history/sessions")) {
        if (!std.mem.eql(u8, method, "GET")) {
            return .{ .status = "405 Method Not Allowed", .body = "{\"error\":\"method not allowed\"}" };
        }
        return .{ .status = "200 OK", .body = "[]" };
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/memory/stats")) {
        return expectGet(allocator, method, buildMemoryStatsJson, cfg, "memory stats build failed");
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/doctor")) {
        if (!std.mem.eql(u8, method, "POST")) {
            return .{ .status = "405 Method Not Allowed", .body = "{\"error\":\"method not allowed\"}" };
        }
        const json = buildDoctorJson(allocator, cfg) catch return .{
            .status = "500 Internal Server Error",
            .body = "{\"error\":\"doctor build failed\"}",
        };
        return .{ .status = "200 OK", .body = json };
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/dependencies")) {
        return expectGet(allocator, method, buildDependenciesJson, cfg, "dependencies build failed");
    }
    if (std.mem.eql(u8, base_path, "/api/desktop/config")) {
        if (std.mem.eql(u8, method, "GET")) {
            const file = std.fs.openFileAbsolute(cfg.config_path, .{}) catch {
                return .{ .status = "500 Internal Server Error", .body = "{\"error\":\"config read failed\"}" };
            };
            defer file.close();
            const raw = file.readToEndAlloc(allocator, 2 * 1024 * 1024) catch {
                return .{ .status = "500 Internal Server Error", .body = "{\"error\":\"config read failed\"}" };
            };
            return .{ .status = "200 OK", .body = raw };
        }
        if (std.mem.eql(u8, method, "PUT")) {
            const body = body_opt orelse return .{ .status = "400 Bad Request", .body = "{\"error\":\"empty body\"}" };
            validateAndPersistConfig(allocator, cfg, body) catch |err| {
                return .{
                    .status = "400 Bad Request",
                    .body = switch (err) {
                        error.ValidationFailed => "{\"error\":\"config validation failed\"}",
                        else => "{\"error\":\"config save failed\"}",
                    },
                };
            };
            return .{ .status = "200 OK", .body = "{\"ok\":true,\"requiresRestart\":true}" };
        }
        return .{ .status = "405 Method Not Allowed", .body = "{\"error\":\"method not allowed\"}" };
    }

    return .{ .status = "404 Not Found", .body = "{\"error\":\"not found\"}" };
}

fn expectGet(
    allocator: std.mem.Allocator,
    method: []const u8,
    comptime builder: fn (std.mem.Allocator, *const Config) anyerror![]u8,
    cfg: *const Config,
    comptime err_body: []const u8,
) DesktopResponse {
    if (!std.mem.eql(u8, method, "GET")) {
        return .{ .status = "405 Method Not Allowed", .body = "{\"error\":\"method not allowed\"}" };
    }
    const json = builder(allocator, cfg) catch return .{
        .status = "500 Internal Server Error",
        .body = "{\"error\":\"" ++ err_body ++ "\"}",
    };
    return .{ .status = "200 OK", .body = json };
}

fn validateAndPersistConfig(
    allocator: std.mem.Allocator,
    current: *const Config,
    raw_body: []const u8,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const arena_allocator = arena.allocator();

    var candidate = config_mod.Config{
        .workspace_dir = current.workspace_dir,
        .config_path = current.config_path,
        .allocator = arena_allocator,
    };
    try candidate.parseJson(raw_body);
    candidate.validate() catch return error.ValidationFailed;
    try writeFileAtomic(allocator, current.config_path, raw_body);
}

fn buildStatusJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "{");
    try json_util.appendJsonKeyValue(&out, allocator, "version", version_mod.string);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(&out, allocator, "workspace_dir", cfg.workspace_dir);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(&out, allocator, "config_path", cfg.config_path);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(&out, allocator, "default_provider", cfg.default_provider);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "default_model");
    if (cfg.default_model) |model| {
        try json_util.appendJsonString(&out, allocator, model);
    } else {
        try out.appendSlice(allocator, "null");
    }
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "gateway");
    try out.appendSlice(allocator, "{");
    try json_util.appendJsonKeyValue(&out, allocator, "host", cfg.gateway.host);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonInt(&out, allocator, "port", cfg.gateway.port);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "require_pairing");
    try out.appendSlice(allocator, if (cfg.gateway.require_pairing) "true" else "false");
    try out.appendSlice(allocator, "},");
    try json_util.appendJsonKey(&out, allocator, "scheduler");
    try out.appendSlice(allocator, "{");
    try json_util.appendJsonKey(&out, allocator, "enabled");
    try out.appendSlice(allocator, if (cfg.scheduler.enabled) "true" else "false");
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonInt(&out, allocator, "max_tasks", cfg.scheduler.max_tasks);
    try out.appendSlice(allocator, "}");
    try out.appendSlice(allocator, "}");
    return out.toOwnedSlice(allocator);
}

fn buildEnvironmentJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    const home_dir = platform.getHomeDir(allocator) catch null;
    defer if (home_dir) |owned| allocator.free(owned);

    try out.appendSlice(allocator, "{");
    try json_util.appendJsonKeyValue(&out, allocator, "workspace_dir", cfg.workspace_dir);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(&out, allocator, "config_path", cfg.config_path);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "home_dir");
    if (home_dir) |path| {
        try json_util.appendJsonString(&out, allocator, path);
    } else {
        try out.appendSlice(allocator, "null");
    }
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(&out, allocator, "runtime_kind", cfg.runtime.kind);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(&out, allocator, "autonomy_level", @tagName(cfg.autonomy.level));
    try out.appendSlice(allocator, "}");
    return out.toOwnedSlice(allocator);
}

fn buildSummaryJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    const agents_json = try buildAgentsJson(allocator, cfg);
    defer allocator.free(agents_json);
    const skills_json = try buildSkillsJson(allocator, cfg);
    defer allocator.free(skills_json);
    const providers_json = try buildProvidersJson(allocator, cfg);
    defer allocator.free(providers_json);
    const schedules_json = try buildSchedulesJson(allocator, cfg);
    defer allocator.free(schedules_json);
    const channels_json = try buildChannelsJson(allocator, cfg);
    defer allocator.free(channels_json);

    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "{");
    try json_util.appendJsonKey(&out, allocator, "inbox");
    try out.appendSlice(allocator, "[],");
    try json_util.appendJsonKey(&out, allocator, "agents");
    try out.appendSlice(allocator, agents_json);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "skills");
    try out.appendSlice(allocator, skills_json);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "providers");
    try out.appendSlice(allocator, providers_json);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "schedules");
    try out.appendSlice(allocator, schedules_json);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "channels");
    try out.appendSlice(allocator, channels_json);
    try out.appendSlice(allocator, "}");
    return out.toOwnedSlice(allocator);
}

fn buildAgentsJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "[");
    for (cfg.agents, 0..) |agent, index| {
        if (index > 0) try out.appendSlice(allocator, ",");
        try out.appendSlice(allocator, "{");
        try json_util.appendJsonKeyValue(&out, allocator, "id", agent.name);
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKeyValue(&out, allocator, "title", agent.name);
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKeyValue(&out, allocator, "model", agent.model);
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKeyValue(&out, allocator, "role", "configured");
        try out.appendSlice(allocator, "}");
    }
    try out.appendSlice(allocator, "]");
    return out.toOwnedSlice(allocator);
}

fn buildSkillsJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    const skills = skills_mod.listSkills(allocator, cfg.workspace_dir) catch try allocator.alloc(skills_mod.Skill, 0);
    defer skills_mod.freeSkills(allocator, skills);

    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "[");
    for (skills, 0..) |skill, index| {
        if (index > 0) try out.appendSlice(allocator, ",");
        try out.appendSlice(allocator, "{");
        try json_util.appendJsonKeyValue(&out, allocator, "name", skill.name);
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKey(&out, allocator, "enabled");
        try out.appendSlice(allocator, if (skill.enabled) "true" else "false");
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKeyValue(&out, allocator, "description", skill.description);
        try out.appendSlice(allocator, "}");
    }
    try out.appendSlice(allocator, "]");
    return out.toOwnedSlice(allocator);
}

fn buildProvidersJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "[");
    for (cfg.providers, 0..) |provider, index| {
        if (index > 0) try out.appendSlice(allocator, ",");
        try out.appendSlice(allocator, "{");
        try json_util.appendJsonKeyValue(&out, allocator, "name", provider.name);
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKeyValue(&out, allocator, "status", if (provider.api_key != null or provider.base_url != null) "configured" else "missing");
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKey(&out, allocator, "defaultModel");
        if (std.mem.eql(u8, provider.name, cfg.default_provider) and cfg.default_model != null) {
            try json_util.appendJsonString(&out, allocator, cfg.default_model.?);
        } else {
            try json_util.appendJsonString(&out, allocator, "");
        }
        try out.appendSlice(allocator, "}");
    }
    try out.appendSlice(allocator, "]");
    return out.toOwnedSlice(allocator);
}

fn buildSchedulesJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    var scheduler = cron_mod.CronScheduler.init(allocator, cfg.scheduler.max_tasks, cfg.scheduler.enabled);
    defer scheduler.deinit();
    cron_mod.loadJobs(&scheduler) catch {};

    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "[");
    for (scheduler.listJobs(), 0..) |job, index| {
        if (index > 0) try out.appendSlice(allocator, ",");
        try out.appendSlice(allocator, "{");
        try json_util.appendJsonKeyValue(&out, allocator, "id", job.id);
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKeyValue(&out, allocator, "name", job.name orelse job.id);
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKeyValue(&out, allocator, "mode", job.job_type.asStr());
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKey(&out, allocator, "nextRun");
        var next_run_buf: [32]u8 = undefined;
        const next_run = std.fmt.bufPrint(&next_run_buf, "{d}", .{job.next_run_secs}) catch "0";
        try json_util.appendJsonString(&out, allocator, next_run);
        try out.appendSlice(allocator, ",");
        try json_util.appendJsonKey(&out, allocator, "enabled");
        try out.appendSlice(allocator, if (job.enabled and !job.paused) "true" else "false");
        try out.appendSlice(allocator, "}");
    }
    try out.appendSlice(allocator, "]");
    return out.toOwnedSlice(allocator);
}

fn buildChannelsJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);
    var count: usize = 0;

    try out.appendSlice(allocator, "[");
    for (cfg.channels.telegram) |item| {
        try appendChannelItem(&out, allocator, &count, "telegram", item.account_id, "configured", "ready");
    }
    for (cfg.channels.discord) |item| {
        try appendChannelItem(&out, allocator, &count, "discord", item.account_id, "configured", "ready");
    }
    for (cfg.channels.slack) |item| {
        try appendChannelItem(&out, allocator, &count, "slack", item.account_id, "configured", "ready");
    }
    for (cfg.channels.teams) |item| {
        try appendChannelItem(&out, allocator, &count, "teams", item.account_id, "configured", "ready");
    }
    for (cfg.channels.web) |item| {
        try appendChannelItem(
            &out,
            allocator,
            &count,
            "web",
            item.account_id,
            if (std.mem.eql(u8, item.listen, "127.0.0.1")) "local" else "configured",
            "ready",
        );
    }
    for (cfg.channels.external) |item| {
        try appendChannelItem(&out, allocator, &count, item.runtime_name, item.account_id, "configured", "ready");
    }
    try out.appendSlice(allocator, "]");
    return out.toOwnedSlice(allocator);
}

fn buildMemoryStatsJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "{");
    try json_util.appendJsonKeyValue(&out, allocator, "backend", cfg.memory.backend);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(&out, allocator, "profile", cfg.memory.profile);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "auto_save");
    try out.appendSlice(allocator, if (cfg.memory.auto_save) "true" else "false");
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "search");
    try out.appendSlice(allocator, "{");
    try json_util.appendJsonKey(&out, allocator, "enabled");
    try out.appendSlice(allocator, if (cfg.memory.search.enabled) "true" else "false");
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(&out, allocator, "provider", cfg.memory.search.provider);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(&out, allocator, "store", cfg.memory.search.store.kind);
    try out.appendSlice(allocator, "}");
    try out.appendSlice(allocator, "}");
    return out.toOwnedSlice(allocator);
}

fn buildDoctorJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    const status_json = try buildStatusJson(allocator, cfg);
    defer allocator.free(status_json);
    const env_json = try buildEnvironmentJson(allocator, cfg);
    defer allocator.free(env_json);

    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "{");
    try json_util.appendJsonKeyValue(&out, allocator, "status", "ok");
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "checks");
    try out.appendSlice(allocator, "[");
    try out.appendSlice(allocator, "{\"name\":\"config\",\"status\":\"ok\"},{\"name\":\"desktop_api\",\"status\":\"ok\"}");
    try out.appendSlice(allocator, "],");
    try json_util.appendJsonKey(&out, allocator, "runtime");
    try out.appendSlice(allocator, status_json);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKey(&out, allocator, "environment");
    try out.appendSlice(allocator, env_json);
    try out.appendSlice(allocator, "}");
    return out.toOwnedSlice(allocator);
}

fn buildDependenciesJson(allocator: std.mem.Allocator, cfg: *const Config) ![]u8 {
    _ = cfg;
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "{");
    try json_util.appendJsonKey(&out, allocator, "core");
    try out.appendSlice(allocator, "[");
    try out.appendSlice(allocator, "{\"name\":\"nullclaw\",\"source\":\"bundled\",\"required\":true}");
    try out.appendSlice(allocator, "],");
    try json_util.appendJsonKey(&out, allocator, "optional");
    try out.appendSlice(allocator, "[");
    try out.appendSlice(allocator, "{\"name\":\"python\",\"source\":\"system\",\"required\":false}");
    try out.appendSlice(allocator, "]");
    try out.appendSlice(allocator, "}");
    return out.toOwnedSlice(allocator);
}

fn appendChannelItem(
    out: *std.ArrayListUnmanaged(u8),
    allocator: std.mem.Allocator,
    count: *usize,
    id: []const u8,
    account_id: []const u8,
    status: []const u8,
    health: []const u8,
) !void {
    if (count.* > 0) try out.appendSlice(allocator, ",");
    count.* += 1;
    try out.appendSlice(allocator, "{");
    try json_util.appendJsonKeyValue(out, allocator, "id", id);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(out, allocator, "account", account_id);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(out, allocator, "status", status);
    try out.appendSlice(allocator, ",");
    try json_util.appendJsonKeyValue(out, allocator, "health", health);
    try out.appendSlice(allocator, "}");
}

fn writeFileAtomic(allocator: std.mem.Allocator, path: []const u8, data: []const u8) !void {
    const tmp_path = try std.fmt.allocPrint(allocator, "{s}.tmp", .{path});
    defer allocator.free(tmp_path);

    const tmp_file = try std.fs.createFileAbsolute(tmp_path, .{});
    errdefer tmp_file.close();
    try tmp_file.writeAll(data);
    tmp_file.close();

    std.fs.renameAbsolute(tmp_path, path) catch {
        std.fs.deleteFileAbsolute(tmp_path) catch {};
        const file = try std.fs.createFileAbsolute(path, .{});
        defer file.close();
        try file.writeAll(data);
    };
}
