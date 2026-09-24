<?php
declare(strict_types=1);

const NICON_CONTACT_RATE_LIMIT = 3;   // per window, mirrors NICON_REGISTER_RATE_LIMIT
const NICON_CONTACT_RATE_WINDOW = 900; // 15 minutes
const NICON_CONTACT_RECIPIENT = 'r.mertner@gmx.de';

// nicon_handle_contact sends a visitor's message to the operator's inbox.
// No login required — this is the page people reach for BEFORE they have
// an account (or don't want one). honeypot is a hidden form field real
// users never fill in; a bot that does gets a fake "sent" response so it
// has no signal to learn from, same reasoning as the rest of this app's
// rate limiting: raise the cost of abuse without adding a CAPTCHA
// dependency.
function nicon_handle_contact(): void
{
    if (!nicon_rate_limit_allow('contact', NICON_CONTACT_RATE_LIMIT, NICON_CONTACT_RATE_WINDOW)) {
        header('Retry-After: ' . NICON_CONTACT_RATE_WINDOW);
        nicon_send_error('too many messages from this address — try again later', 429);
        return;
    }

    $req = nicon_json_body();
    $honeypot = trim((string) ($req['website'] ?? ''));
    $name = trim((string) ($req['name'] ?? ''));
    $email = trim((string) ($req['email'] ?? ''));
    $message = trim((string) ($req['message'] ?? ''));

    if ($honeypot !== '') {
        nicon_send_json(['ok' => true]);
        return;
    }

    if ($name === '' || $email === '' || $message === '') {
        nicon_send_error('name, email, and message are required', 400);
        return;
    }
    if (strlen($name) > 200 || strlen($message) > 5000) {
        nicon_send_error('name or message is too long', 400);
        return;
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        nicon_send_error('please enter a valid email address', 400);
        return;
    }

    // Header injection guard: a bare validated email can't contain a
    // newline, but strip_new_lines defensively since $name is free text.
    $stripNewlines = static fn (string $s): string => str_replace(["\r", "\n"], ' ', $s);
    $name = $stripNewlines($name);

    $subject = 'NiCon contact form: ' . $name;
    $body = "Name: {$name}\nEmail: {$email}\n\n{$message}\n";
    $headers = [
        'From: NiCon <no-reply@nicon.mylss.de>',
        'Reply-To: ' . $stripNewlines($email),
        'Content-Type: text/plain; charset=UTF-8',
    ];

    $sent = @mail(NICON_CONTACT_RECIPIENT, $subject, $body, implode("\r\n", $headers));
    if (!$sent) {
        nicon_send_error('could not send your message — try again later', 502);
        return;
    }

    nicon_send_json(['ok' => true]);
}
