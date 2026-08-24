// Helper aislado del módulo Reservas IA.
// No modifica el sistema global de emails ni otras rutas.
// @ts-ignore
import nodemailer from 'nodemailer';

type MailResult = { ok: true } | { ok: false; error: string };

type BaseReservationEmailInput = {
  to?: string | null;
  customerName: string;
  serviceName: string;
  resourceName: string;
  startAt: string;
  endAt: string;
  timezone: string;
  publicUrl?: string | null;
  calendarSynced?: boolean;
};

type ReservationStatusEmailInput = BaseReservationEmailInput & {
  status: 'cancelled' | 'rescheduled';
  reason?: string | null;
};

function clean(value: unknown) {
  return String(value ?? '').trim();
}

function escapeHtml(value: unknown) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDateTime(value: string, timezone: string) {
  try {
    return new Intl.DateTimeFormat('es', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: timezone || 'America/Santo_Domingo',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

async function sendMail(params: { to: string; subject: string; html: string }): Promise<MailResult> {
  const smtpHost = process.env.SMTP_HOST || 'mail.smtp2go.com';
  const smtpPort = Number(process.env.SMTP_PORT || '587');
  const smtpUser = process.env.SMTP_USER || '';
  const smtpPass = process.env.SMTP_PASS || '';
  const fromName = process.env.SMTP_FROM_NAME || 'AllSender';
  const fromEmail = process.env.SMTP_FROM_EMAIL || smtpUser || 'no-reply@example.com';

  if (!smtpUser || !smtpPass) {
    return { ok: false, error: 'SMTP no configurado.' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    await transporter.sendMail({
      from: `\"${fromName}\" <${fromEmail}>`,
      to: params.to,
      subject: params.subject,
      html: params.html,
    });

    return { ok: true };
  } catch (error: any) {
    console.error('[reservas:email]', error?.message || error);
    return { ok: false, error: error?.message || 'No se pudo enviar email.' };
  }
}

function reservationDetailsTable(input: BaseReservationEmailInput) {
  const startText = formatDateTime(input.startAt, input.timezone);
  const endText = formatDateTime(input.endAt, input.timezone);
  return `
    <table style="width:100%;border-collapse:separate;border-spacing:0 10px;font-size:15px;">
      <tr><td style="color:#64748b;width:130px;">Servicio</td><td><strong>${escapeHtml(input.serviceName || 'Reserva')}</strong></td></tr>
      <tr><td style="color:#64748b;">Recurso</td><td><strong>${escapeHtml(input.resourceName || 'Equipo')}</strong></td></tr>
      <tr><td style="color:#64748b;">Inicio</td><td><strong>${escapeHtml(startText)}</strong></td></tr>
      <tr><td style="color:#64748b;">Fin</td><td>${escapeHtml(endText)}</td></tr>
      <tr><td style="color:#64748b;">Calendario</td><td>${input.calendarSynced ? 'Sincronizado con Google Calendar' : 'Registrado en AllSender'}</td></tr>
    </table>
  `;
}

function emailLayout({ eyebrow, title, body, color = '#2563eb' }: { eyebrow: string; title: string; body: string; color?: string }) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a;">
      <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden;box-shadow:0 20px 50px rgba(15,23,42,.08);">
        <div style="background:linear-gradient(135deg,${color},#7c3aed);padding:26px;color:white;">
          <div style="font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.86;">${escapeHtml(eyebrow)}</div>
          <h1 style="margin:10px 0 0;font-size:28px;line-height:1.15;">${escapeHtml(title)}</h1>
        </div>
        <div style="padding:26px;">${body}</div>
      </div>
    </div>
  `;
}

export async function sendReservationConfirmationEmail(input: BaseReservationEmailInput): Promise<MailResult> {
  const to = clean(input.to).toLowerCase();
  if (!to || !to.includes('@')) return { ok: false, error: 'Email del cliente no válido o vacío.' };

  const html = emailLayout({
    eyebrow: 'AllSender Reservas IA',
    title: 'Tu reserva fue confirmada',
    body: `
      <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">Hola <strong>${escapeHtml(input.customerName || 'cliente')}</strong>, tu reserva fue registrada correctamente.</p>
      ${reservationDetailsTable(input)}
      ${input.publicUrl ? `<p style="margin:22px 0 0;"><a href="${escapeHtml(input.publicUrl)}" style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:800;">Abrir página de reservas</a></p>` : ''}
      <p style="font-size:13px;color:#64748b;margin-top:24px;line-height:1.6;">Este mensaje fue enviado automáticamente por AllSender Reservas IA. Si necesitas cambiar la cita, responde al negocio por el mismo canal donde realizaste la reserva.</p>
    `,
  });

  return sendMail({
    to,
    subject: `Reserva confirmada: ${input.serviceName || 'AllSender Reservas IA'}`,
    html,
  });
}

export async function sendReservationReminderEmail(input: BaseReservationEmailInput): Promise<MailResult> {
  const to = clean(input.to).toLowerCase();
  if (!to || !to.includes('@')) return { ok: false, error: 'Email del cliente no válido o vacío.' };

  const html = emailLayout({
    eyebrow: 'Recordatorio de reserva',
    title: 'Te recordamos tu próxima cita',
    color: '#0f9d58',
    body: `
      <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">Hola <strong>${escapeHtml(input.customerName || 'cliente')}</strong>, tienes una reserva próxima.</p>
      ${reservationDetailsTable(input)}
      ${input.publicUrl ? `<p style="margin:22px 0 0;"><a href="${escapeHtml(input.publicUrl)}" style="display:inline-block;background:#0f9d58;color:white;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:800;">Ver detalles</a></p>` : ''}
      <p style="font-size:13px;color:#64748b;margin-top:24px;line-height:1.6;">Este recordatorio fue enviado automáticamente por AllSender Reservas IA.</p>
    `,
  });

  return sendMail({
    to,
    subject: `Recordatorio: ${input.serviceName || 'tu reserva'}`,
    html,
  });
}

export async function sendReservationStatusEmail(input: ReservationStatusEmailInput): Promise<MailResult> {
  const to = clean(input.to).toLowerCase();
  if (!to || !to.includes('@')) return { ok: false, error: 'Email del cliente no válido o vacío.' };

  const isCancelled = input.status === 'cancelled';
  const title = isCancelled ? 'Tu reserva fue cancelada' : 'Tu reserva fue reprogramada';
  const color = isCancelled ? '#dc2626' : '#2563eb';
  const html = emailLayout({
    eyebrow: 'Actualización de reserva',
    title,
    color,
    body: `
      <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">Hola <strong>${escapeHtml(input.customerName || 'cliente')}</strong>, ${isCancelled ? 'tu reserva fue cancelada.' : 'tu reserva fue actualizada con una nueva fecha/hora.'}</p>
      ${reservationDetailsTable(input)}
      ${input.reason ? `<p style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;font-size:14px;color:#334155;"><strong>Nota:</strong> ${escapeHtml(input.reason)}</p>` : ''}
      ${input.publicUrl ? `<p style="margin:22px 0 0;"><a href="${escapeHtml(input.publicUrl)}" style="display:inline-block;background:${color};color:white;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:800;">Abrir página de reservas</a></p>` : ''}
      <p style="font-size:13px;color:#64748b;margin-top:24px;line-height:1.6;">Este mensaje fue enviado automáticamente por AllSender Reservas IA.</p>
    `,
  });

  return sendMail({
    to,
    subject: `${title}: ${input.serviceName || 'AllSender Reservas IA'}`,
    html,
  });
}
