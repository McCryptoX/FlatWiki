/**
 * FlatWiki Mailer – nodemailer-Wrapper für E-Mail-Benachrichtigungen.
 *
 * Konfiguration via config.env:
 *   SMTP_HOST=smtp.example.com
 *   SMTP_PORT=587
 *   SMTP_SECURE=false     (true für Port 465 / direktes TLS)
 *   SMTP_USER=user@example.com
 *   SMTP_PASS=geheimes-passwort
 *   SMTP_FROM=FlatWiki <wiki@example.com>
 *
 * Wenn SMTP_HOST leer ist, werden alle Mail-Aufrufe still ignoriert.
 */

import { config } from "../config.js";
import type { Transporter } from "nodemailer";
import { getSmtpSettings } from "./runtimeSettingsStore.js";

let _transporter: Transporter | null = null;
let _transporterKey = "";

const getTransporter = async (): Promise<Transporter | null> => {
  const smtp = await getSmtpSettings();
  if (smtp.host.length < 1) return null;
  const key = JSON.stringify({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    user: smtp.user,
    pass: smtp.pass
  });

  if (_transporter && key === _transporterKey) {
    return _transporter;
  }

  try {
    // Dynamischer Import damit nodemailer nicht geladen wird wenn nicht konfiguriert.
    const nodemailer = await import("nodemailer");
    _transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user
        ? {
            auth: {
              user: smtp.user,
              pass: smtp.pass
            }
          }
        : {})
    });
    _transporterKey = key;
    return _transporter;
  } catch (err) {
    console.warn("[mailer] nodemailer konnte nicht initialisiert werden:", err);
    _transporter = null;
    _transporterKey = "";
    return null;
  }
};

interface MailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sendet eine E-Mail. Gibt bei fehlender SMTP-Konfiguration oder leerem `to` still auf.
 */
export const sendMail = async (options: MailOptions): Promise<boolean> => {
  if (!options.to.includes("@")) return false;
  const smtp = await getSmtpSettings();
  const transporter = await getTransporter();
  if (!transporter) return false;

  try {
    await transporter.sendMail({
      from: smtp.from || config.smtpFrom || "FlatWiki <noreply@flatwiki>",
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text
    });
    return true;
  } catch (err) {
    // Fehler beim Mail-Versand dürfen die Anwendung nicht unterbrechen
    console.warn("[mailer] E-Mail-Versand fehlgeschlagen:", err);
    return false;
  }
};

// ─── E-Mail-Templates ─────────────────────────────────────────────────────────

const wikiTitle = config.wikiTitle;
const baseUrl = config.publicBaseUrl || "";

const wrapHtml = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title.replace(/</g, "&lt;")}</title>
</head>
<body style="margin:0;padding:0;background:#111118;color:#e4e5eb;font-family:system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center" style="padding:2rem 1rem;">
        <table width="560" cellpadding="0" cellspacing="0" role="presentation"
               style="background:#1a1a27;border:1px solid #2d2d3d;border-radius:8px;overflow:hidden;max-width:100%;">
          <tr>
            <td style="padding:1.25rem 1.5rem;background:#1a1a27;border-bottom:1px solid #2d2d3d;">
              <strong style="color:#818cf8;font-size:1rem;">${wikiTitle}</strong>
            </td>
          </tr>
          <tr>
            <td style="padding:1.5rem;">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:0.75rem 1.5rem;background:#111118;border-top:1px solid #2d2d3d;">
              <span style="color:#9ca3af;font-size:0.8rem;">Diese Nachricht wurde automatisch von ${wikiTitle} gesendet.</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

/**
 * E-Mail bei Seitenänderung für Beobachter (Watch-Funktion).
 */
export const sendPageUpdateNotification = async (opts: {
  toEmail: string;
  toDisplayName: string;
  pageTitle: string;
  pageSlug: string;
  actorDisplayName: string;
  eventType: "page_update" | "comment" | "workflow";
}): Promise<void> => {
  const url = `${baseUrl}/wiki/${encodeURIComponent(opts.pageSlug)}`;
  const eventLabel =
    opts.eventType === "comment" ? "kommentiert" : opts.eventType === "workflow" ? "im Workflow geändert" : "aktualisiert";

  const subject = `[${wikiTitle}] „${opts.pageTitle}" wurde ${eventLabel}`;
  const html = wrapHtml(
    subject,
    `<p style="margin:0 0 1rem;color:#e4e5eb;">Hallo ${opts.toDisplayName},</p>
     <p style="margin:0 0 1rem;color:#e4e5eb;">
       <strong>${opts.actorDisplayName}</strong> hat die Seite
       <strong>„${opts.pageTitle}"</strong> ${eventLabel}, die du beobachtest.
     </p>
     <p style="margin:0 0 1.5rem;">
       <a href="${url}" style="display:inline-block;padding:0.6rem 1.2rem;background:#818cf8;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Seite öffnen</a>
     </p>
     <p style="color:#9ca3af;font-size:0.85rem;margin:0;">
       Du erhältst diese Nachricht, weil du diese Seite beobachtest.<br/>
       Um die Benachrichtigungen zu stoppen, öffne die Seite und klicke auf „Beobachtet".
     </p>`
  );
  const text = `Hallo ${opts.toDisplayName},\n\n${opts.actorDisplayName} hat „${opts.pageTitle}" ${eventLabel}.\n\nSeite öffnen: ${url}\n\n— ${wikiTitle}`;

  await sendMail({ to: opts.toEmail, subject, html, text });
};

/**
 * E-Mail bei @-Erwähnung in einem Kommentar.
 */
export const sendMentionNotification = async (opts: {
  toEmail: string;
  toDisplayName: string;
  pageTitle: string;
  pageSlug: string;
  commentId: string;
  actorDisplayName: string;
}): Promise<void> => {
  const url = `${baseUrl}/wiki/${encodeURIComponent(opts.pageSlug)}#comment-${encodeURIComponent(opts.commentId)}`;
  const subject = `[${wikiTitle}] ${opts.actorDisplayName} hat dich in „${opts.pageTitle}" erwähnt`;
  const html = wrapHtml(
    subject,
    `<p style="margin:0 0 1rem;color:#e4e5eb;">Hallo ${opts.toDisplayName},</p>
     <p style="margin:0 0 1rem;color:#e4e5eb;">
       <strong>${opts.actorDisplayName}</strong> hat dich in einem Kommentar auf
       <strong>„${opts.pageTitle}"</strong> erwähnt.
     </p>
     <p style="margin:0 0 1.5rem;">
       <a href="${url}" style="display:inline-block;padding:0.6rem 1.2rem;background:#818cf8;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Kommentar anzeigen</a>
     </p>`
  );
  const text = `Hallo ${opts.toDisplayName},\n\n${opts.actorDisplayName} hat dich in „${opts.pageTitle}" erwähnt.\n\nKommentar: ${url}\n\n— ${wikiTitle}`;

  await sendMail({ to: opts.toEmail, subject, html, text });
};
