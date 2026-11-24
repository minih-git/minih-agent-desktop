import { useTranslation } from "react-i18next";
import { Input, Select } from "../ui";
import { defaultMailPort } from "./mail-endpoint";
import type { CredentialValues } from "./PluginCredentials";

/**
 * The optional "use my own mail server" part of a mailbox slot whose manifest
 * declares `userEndpoint`.
 *
 * These four values belong to the account, not to the plugin: the app stores
 * them with the password and logs in at that server and nowhere else, which is
 * why the plugin's own form cannot offer them. Leaving the server empty keeps
 * the account on the plugin's preset servers.
 */
export function CustomMailServerFields({
  protocols,
  values,
  onChange,
  disabled,
}: {
  protocols: readonly string[];
  values: CredentialValues;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const protocol = values.protocol || protocols[0] || "imap";
  const security = values.security || "tls";
  const port = values.port ?? "";

  // A server without a port is not an account anyone can use, so naming one
  // fills the three values the user did not touch yet.
  const setServer = (value: string) => {
    if (value.trim() && !values.server) {
      onChange("protocol", protocol);
      onChange("security", security);
      onChange("port", port || defaultMailPort(protocol, security));
    }
    onChange("server", value);
  };
  const setProtocol = (next: string) => {
    onChange("protocol", next);
    if (!port || port === defaultMailPort(protocol, security)) {
      onChange("port", defaultMailPort(next, security));
    }
  };
  const setSecurity = (next: string) => {
    onChange("security", next);
    if (!port || port === defaultMailPort(protocol, security)) {
      onChange("port", defaultMailPort(protocol, next));
    }
  };

  return (
    <details className="plugin-credential-endpoint">
      <summary>{t("pluginCredentials.customServer")}</summary>
      <p className="plugin-credential-endpoint-hint">
        {t("pluginCredentials.customServerHint")}
      </p>
      <div className="plugin-credential-field">
        <span>{t("pluginCredentials.customServerServer")}</span>
        <Input
          value={values.server ?? ""}
          onChange={(event) => setServer(event.target.value)}
          placeholder={t("pluginCredentials.customServerServerPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          aria-label={t("pluginCredentials.customServerServer")}
          disabled={disabled}
        />
      </div>
      <div className="plugin-credential-field">
        <span>{t("pluginCredentials.customServerProtocol")}</span>
        <Select
          value={protocol}
          onChange={(event) => setProtocol(event.target.value)}
          aria-label={t("pluginCredentials.customServerProtocol")}
          disabled={disabled}
        >
          {protocols.map((option) => (
            <option value={option} key={option}>
              {option === "pop3"
                ? t("pluginCredentials.customServerProtocolPop3")
                : t("pluginCredentials.customServerProtocolImap")}
            </option>
          ))}
        </Select>
      </div>
      <div className="plugin-credential-field">
        <span>{t("pluginCredentials.customServerSecurity")}</span>
        <Select
          value={security}
          onChange={(event) => setSecurity(event.target.value)}
          aria-label={t("pluginCredentials.customServerSecurity")}
          disabled={disabled}
        >
          <option value="tls">{t("pluginCredentials.customServerSecurityTls")}</option>
          <option value="starttls">
            {t("pluginCredentials.customServerSecurityStarttls")}
          </option>
        </Select>
      </div>
      <div className="plugin-credential-field">
        <span>{t("pluginCredentials.customServerPort")}</span>
        <Input
          value={port}
          onChange={(event) => onChange("port", event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          aria-label={t("pluginCredentials.customServerPort")}
          disabled={disabled}
        />
      </div>
    </details>
  );
}