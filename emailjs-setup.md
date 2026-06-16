# Automatic Invite Email Setup

Avantex Work Tracker can send workspace invite emails automatically through EmailJS.

## Required EmailJS values

Add these values in `app.js`:

```js
const EMAILJS_SERVICE_ID = "your_service_id";
const EMAILJS_TEMPLATE_ID = "your_template_id";
const EMAILJS_PUBLIC_KEY = "your_public_key";
```

## EmailJS template variables

Create an EmailJS template with these variables:

```text
{{to_email}}
{{to_name}}
{{from_name}}
{{workspace_name}}
{{invite_link}}
{{subject}}
{{message}}
```

Recommended template:

Subject:

```text
{{subject}}
```

Body:

```text
Hi {{to_name}},

{{from_name}} invited you to join {{workspace_name}} on Avantex Work Tracker.

Open your invite:
{{invite_link}}

If you do not have an account, sign up with this same email first. After email confirmation, login and the invite will be accepted.
```

## Current behavior

- If EmailJS keys are configured, invite email sends automatically after clicking `Create Email Invite`.
- If keys are missing or sending fails, the app opens a normal email draft as fallback.
