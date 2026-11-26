import { useTranslation } from "react-i18next";
import { Input, PasswordInput, Select } from "../ui";
import type { CredentialValues } from "./PluginCredentials";

/**
 * The optional "connect through my own proxy" part of a mailbox slot whose
 * manifest declares `userProxy`.
 *
 * The proxy belongs to the account: it is stored with the password and dialled
 * only for that account's connections, which is why the plugin's own form cannot
 * offer it. Choosing no type keeps the account on a direct connection.
 *
 * A stored proxy login is never prefilled — the user name is host-only, exactly
 * like the password — so the two boxes are filled in only to replace it: left
 * empty, a save keeps the login the account already has.
 */
export function CustomMailProxyFields({
  types,
  values,
  onChange,
  disabled,
}: {
  types: readonly string[];
  values: CredentialValues;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const type = values.proxyType ?? "";

  return (
    <details className="plugin-credential-endpoint">
      <summary>{t("pluginCredentials.proxy")}</summary>
      <p className="plugin-credential-endpoint-hint">{t("pluginCredentials.proxyHint")}</p>
      <div className="plugin-credential-field">
        <span>{t("pluginCredentials.proxyType")}</span>
        <Select
          value={type}
          onChange={(event) => {
            const next = event.target.value;
            onChange("proxyType", next);
            // "No proxy" is a statement about the whole section, so the address
            // and the login go with it: an empty type plus a leftover address
            // would be refused as a half-filled proxy.
            if (!next) {
              for (const key of ["proxyHost", "proxyPort", "proxyUsername", "proxyPassword"]) {
                onChange(key, "");
              }
            }
          }}
          aria-label={t("pluginCredentials.proxyType")}
          disabled={disabled}
        >
          <option value="">{t("pluginCredentials.proxyTypeNone")}</option>
          {types.map((option) => (
            <option value={option} key={option}>
              {option === "socks5"
                ? t("pluginCredentials.proxyTypeSocks5")
                : t("pluginCredentials.proxyTypeHttp")}
            </option>
          ))}
        </Select>
      </div>
      {type ? (
        <>
          <div className="plugin-credential-field">
            <span>{t("pluginCredentials.proxyHost")}</span>
            <Input
              value={values.proxyHost ?? ""}
              onChange={(event) => onChange("proxyHost", event.target.value)}
              placeholder={t("pluginCredentials.proxyHostPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              aria-label={t("pluginCredentials.proxyHost")}
              disabled={disabled}
            />
          </div>
          <div className="plugin-credential-field">
            <span>{t("pluginCredentials.proxyPort")}</span>
            <Input
              value={values.proxyPort ?? ""}
              onChange={(event) => onChange("proxyPort", event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              aria-label={t("pluginCredentials.proxyPort")}
              disabled={disabled}
            />
          </div>
          <div className="plugin-credential-field">
            <span>{t("pluginCredentials.proxyUsername")}</span>
            <Input
              value={values.proxyUsername ?? ""}
              onChange={(event) => onChange("proxyUsername", event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label={t("pluginCredentials.proxyUsername")}
              disabled={disabled}
            />
          </div>
          <div className="plugin-credential-field">
            <span>{t("pluginCredentials.proxyPassword")}</span>
            <PasswordInput
              value={values.proxyPassword ?? ""}
              onChange={(event) => onChange("proxyPassword", event.target.value)}
              showLabel={t("pluginCredentials.show")}
              hideLabel={t("pluginCredentials.hide")}
              autoComplete="off"
              aria-label={t("pluginCredentials.proxyPassword")}
              disabled={disabled}
            />
          </div>
          <p className="plugin-credential-endpoint-hint">
            {t("pluginCredentials.proxyLoginHint")}
          </p>
        </>
      ) : null}
    </details>
  );
}