import { describe, expect, it } from "vitest";
import {
  MAX_WEBHOOK_BODY_BYTES,
  PLUGIN_PERMISSIONS,
  PLUGIN_PERMISSION_RISK,
  parseNetTcpEndpoints,
  pluginPermissionRisk,
  validateContributions,
  credentialFieldType,
  validateCredentialContributions,
  validateManifest,
  validateScheduleContributions,
  validateWebhookContributions,
  type PluginManifest,
} from "./index.js";

const base = { schemaVersion: 1, id: "demo.x", name: "X", version: "0.1.0", main: "main.js" };

/** The eight host capabilities registered by B-0. */
const HOST_CAPABILITY_PERMISSIONS = [
  "credentials.use",
  "net.tcp",
  "inbound.webhook",
  "mail.draft",
  "notify.center",
  "scheduler",
  "tasks.read",
  "tasks.manage",
] as const;

function slot(overrides: Record<string, unknown> = {}) {
  return {
    id: "mailbox",
    title: { en: "Mailbox", "zh-CN": "邮箱" },
    kind: "basic",
    fields: [{ key: "username", label: { en: "User", "zh-CN": "用户" } }],
    ...overrides,
  };
}

describe("host capability permissions", () => {
  it("registers the eight capability names", () => {
    for (const permission of HOST_CAPABILITY_PERMISSIONS) {
      expect(PLUGIN_PERMISSIONS).toContain(permission);
    }
  });

  it("grades every permission, and the capability names as designed", () => {
    for (const permission of PLUGIN_PERMISSIONS) {
      expect(PLUGIN_PERMISSION_RISK[permission]).toMatch(/^(low|medium|high)$/);
    }
    expect(pluginPermissionRisk("credentials.use")).toBe("high");
    expect(pluginPermissionRisk("net.tcp")).toBe("high");
    expect(pluginPermissionRisk("inbound.webhook")).toBe("high");
    expect(pluginPermissionRisk("tasks.manage")).toBe("high");
    expect(pluginPermissionRisk("mail.draft")).toBe("medium");
    expect(pluginPermissionRisk("notify.center")).toBe("medium");
    expect(pluginPermissionRisk("scheduler")).toBe("medium");
    expect(pluginPermissionRisk("tasks.read")).toBe("medium");
  });

  it("treats an unclassified permission as high risk", () => {
    expect(pluginPermissionRisk("something.new")).toBe("high");
  });
});

describe("contributes.credentials", () => {
  it("accepts a slot with a scoped domain list", () => {
    expect(validateCredentialContributions([slot({ scope: { domains: ["imap.example.com"] } })])).toBe(
      undefined,
    );
  });

  it("refuses an unknown kind, a duplicate id and an empty field list", () => {
    expect(validateCredentialContributions([slot({ kind: "cookie" })])).toMatch(/unsupported kind/);
    expect(validateCredentialContributions([slot(), slot()])).toMatch(/duplicate credential id/);
    expect(validateCredentialContributions([slot({ fields: [] })])).toMatch(/requires fields/);
  });

  it("refuses a scope nobody could inject into", () => {
    expect(validateCredentialContributions([slot({ scope: { domains: [] } })])).toMatch(
      /at least one domain/,
    );
    expect(validateCredentialContributions([slot({ scope: { domains: ["*"] } })])).toMatch(
      /must not contain/,
    );
  });
});

describe("contributes.credentials: multiple, labelField, field controls", () => {
  const multi = (overrides: Record<string, unknown> = {}) =>
    slot({ multiple: { max: 3 }, labelField: "username", ...overrides });

  it("accepts a multi-instance slot with a labelled public field", () => {
    expect(validateCredentialContributions([multi()])).toBe(undefined);
  });

  it("keeps a single-instance slot valid exactly as released", () => {
    // No `multiple`, no `labelField`, no `type`, no `options`.
    expect(validateCredentialContributions([slot()])).toBe(undefined);
  });

  it("bounds multiple.max to the host's 1..5 window", () => {
    expect(validateCredentialContributions([slot({ multiple: { max: 1 } })])).toBe(undefined);
    expect(validateCredentialContributions([slot({ multiple: { max: 5 } })])).toBe(undefined);
    expect(validateCredentialContributions([slot({ multiple: { max: 0 } })])).toMatch(
      /multiple\.max must be an integer from 1 to 5/,
    );
    expect(validateCredentialContributions([slot({ multiple: { max: 6 } })])).toMatch(
      /multiple\.max must be an integer from 1 to 5/,
    );
    expect(validateCredentialContributions([slot({ multiple: { max: 2.5 } })])).toMatch(
      /multiple\.max/,
    );
    expect(validateCredentialContributions([slot({ multiple: {} })])).toMatch(/multiple\.max/);
    expect(validateCredentialContributions([slot({ multiple: "yes" })])).toMatch(
      /multiple must be an object/,
    );
  });

  it("refuses a labelField that is missing, undeclared, or secret", () => {
    expect(validateCredentialContributions([multi({ labelField: "missing" })])).toMatch(
      /is not a declared field/,
    );
    expect(
      validateCredentialContributions([
        multi({
          fields: [
            { key: "username", label: "User" },
            { key: "password", label: "Password", secret: true },
          ],
          labelField: "password",
        }),
      ]),
    ).toMatch(/must not be secret/);
    expect(validateCredentialContributions([multi({ labelField: "not a key" })])).toMatch(
      /labelField must be a field key/,
    );
  });

  it("reads a field control from type, else from secret", () => {
    expect(
      credentialFieldType({ key: "a", label: "A" }),
    ).toBe("text");
    expect(credentialFieldType({ key: "a", label: "A", secret: true })).toBe("password");
    expect(credentialFieldType({ key: "a", label: "A", secret: true, type: "text" })).toBe("text");
  });

  it("accepts a select field with localized option labels", () => {
    expect(
      validateCredentialContributions([
        slot({
          fields: [
            { key: "username", label: "User" },
            {
              key: "security",
              label: { en: "Security", "zh-CN": "安全" },
              type: "select",
              options: [
                { value: "tls", label: { en: "TLS", "zh-CN": "TLS" } },
                { value: "starttls", label: "STARTTLS" },
              ],
            },
          ],
        }),
      ]),
    ).toBe(undefined);
  });

  it("refuses the field controls the Settings sheet cannot render", () => {
    const refuse = (field: unknown) =>
      validateCredentialContributions([
        slot({ fields: [{ key: "username", label: "User" }, field] }),
      ]);
    expect(refuse({ key: "x", label: "X", type: "switch" })).toMatch(
      /type must be text, password, or select/,
    );
    expect(refuse({ key: "x", label: "X", secret: true, type: "select", options: [{ value: "a", label: "A" }] })).toMatch(
      /cannot be secret and a select/,
    );
    expect(refuse({ key: "x", label: "X", options: [{ value: "a", label: "A" }] })).toMatch(
      /declares options but is not a select/,
    );
    expect(refuse({ key: "x", label: "X", type: "select" })).toMatch(
      /is a select without options/,
    );
    expect(refuse({ key: "x", label: "X", type: "select", options: [] })).toMatch(
      /is a select without options/,
    );
    expect(refuse({ key: "x", label: "X", type: "select", options: [{ value: "", label: "A" }] })).toMatch(
      /option without a value/,
    );
    expect(
      refuse({
        key: "x",
        label: "X",
        type: "select",
        options: [
          { value: "a", label: "A" },
          { value: "a", label: "B" },
        ],
      }),
    ).toMatch(/declares option "a" twice/);
    expect(refuse({ key: "x", label: "X", type: "select", options: [{ value: "a", label: "" }] })).toMatch(
      /label/,
    );
    expect(
      refuse({ key: "x", label: "X", type: "select", options: [{ value: "a", label: { en: "A" } }] }),
    ).toMatch(/zh-CN/);
  });
});

describe("contributes.webhooks", () => {
  it("accepts bounds at or below the ceilings", () => {
    expect(
      validateWebhookContributions([
        { id: "gitea", title: "Gitea", maxBodyBytes: MAX_WEBHOOK_BODY_BYTES, ratePerMinute: 120 },
      ]),
    ).toBeUndefined();
  });

  it("refuses a body ceiling above 256 KiB or a rate above 120", () => {
    expect(
      validateWebhookContributions([
        { id: "gitea", title: "Gitea", maxBodyBytes: MAX_WEBHOOK_BODY_BYTES + 1 },
      ]),
    ).toMatch(/maxBodyBytes/);
    expect(
      validateWebhookContributions([{ id: "gitea", title: "Gitea", ratePerMinute: 121 }]),
    ).toMatch(/ratePerMinute/);
  });
});

describe("contributes.schedules", () => {
  it("accepts an interval or a cron, but not both", () => {
    expect(validateScheduleContributions([{ id: "poll", title: "Poll", every: "5m" }])).toBe(
      undefined,
    );
    expect(
      validateScheduleContributions([{ id: "poll", title: "Poll", cron: "0 9 * * *" }]),
    ).toBeUndefined();
    expect(
      validateScheduleContributions([{ id: "poll", title: "Poll", every: "5m", cron: "0 9 * * *" }]),
    ).toMatch(/exactly one of every or cron/);
  });

  it("refuses a tick faster than one minute and a malformed cron", () => {
    expect(validateScheduleContributions([{ id: "poll", title: "Poll", every: "30s" }])).toMatch(
      /at least one minute/,
    );
    expect(validateScheduleContributions([{ id: "poll", title: "Poll", cron: "0 9 *" }])).toMatch(
      /five-field/,
    );
  });
});

describe("manifest.net.tcp", () => {
  it("accepts literal endpoints and normalizes the host", () => {
    const parsed = parseNetTcpEndpoints([{ host: "IMAP.Example.com", port: 993, tls: true }]);
    expect(parsed.ok).toBe(true);
    expect(parsed.endpoints).toEqual([{ host: "imap.example.com", port: 993, tls: true }]);
  });

  it("refuses wildcards, missing tls, bad ports and duplicates", () => {
    expect(parseNetTcpEndpoints([{ host: "*.example.com", port: 993, tls: true }]).error).toMatch(
      /literal/,
    );
    expect(parseNetTcpEndpoints([{ host: "imap.example.com", port: 993 }]).error).toMatch(/tls/);
    expect(parseNetTcpEndpoints([{ host: "imap.example.com", port: 0, tls: true }]).error).toMatch(
      /port/,
    );
    expect(
      parseNetTcpEndpoints([
        { host: "imap.example.com", port: 993, tls: true },
        { host: "imap.example.com", port: 993, tls: true },
      ]).error,
    ).toMatch(/twice/);
  });

  it("allows more than four declared endpoints", () => {
    const endpoints = Array.from({ length: 5 }, (_, index) => ({
      host: `host${index}.example.com`,
      port: 993,
      tls: true,
    }));
    expect(parseNetTcpEndpoints(endpoints).ok).toBe(true);
  });
});

describe("validateManifest host capability blocks", () => {
  it("requires the matching permission for every declared block", () => {
    const contributes = {
      credentials: [slot()],
      webhooks: [{ id: "gitea", title: "Gitea" }],
      schedules: [{ id: "poll", title: "Poll", every: "5m" }],
    };
    const missing = validateManifest({ ...base, contributes });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/credentials.use/);

    const granted = validateManifest({
      ...base,
      contributes,
      permissions: ["credentials.use", "inbound.webhook", "scheduler"],
    });
    expect(granted.ok).toBe(true);
  });

  it("requires net.tcp for declared endpoints", () => {
    const net = { tcp: [{ host: "imap.example.com", port: 993, tls: true }] };
    expect(validateManifest({ ...base, net }).error).toMatch(/net\.tcp permission/);
    expect(validateManifest({ ...base, net, permissions: ["net.tcp"] }).ok).toBe(true);
  });

  it("requires tasks.manage for a declared maxPermission ceiling", () => {
    const tasks = { manage: { maxPermission: "auto" } };
    expect(validateManifest({ ...base, tasks }).error).toMatch(/tasks\.manage permission/);
    expect(validateManifest({ ...base, tasks, permissions: ["tasks.manage"] }).ok).toBe(true);
  });

  it("refuses an unknown permission mode and a malformed tasks block", () => {
    expect(
      validateManifest({ ...base, tasks: { manage: { maxPermission: "yolo" } }, permissions: ["tasks.manage"] })
        .error,
    ).toMatch(/maxPermission/);
    expect(validateManifest({ ...base, tasks: "auto" }).error).toMatch(/manifest\.tasks must be an object/);
  });
});

describe("validateContributions host capability shapes", () => {
  it("reports a malformed capability block through the contribution check", () => {
    // A manifest is JSON at the boundary, so the wrong `kind` is a runtime
    // shape despite the type: the check under test is the runtime one.
    const malformed = { credentials: [slot({ kind: "nope" })] } as PluginManifest["contributes"];
    expect(validateContributions(malformed)).toMatch(/unsupported kind/);
    expect(validateContributions({ schedules: [{ id: "poll", title: "Poll" }] })).toMatch(
      /exactly one of every or cron/,
    );
    expect(validateContributions({ webhooks: [{ id: "gitea", title: "Gitea", ratePerMinute: 0 }] })).toMatch(
      /ratePerMinute/,
    );
  });
});