// Tests never talk to Claude or PayPal: wipe any real credentials from the environment.
for (const k of ["ANTHROPIC_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "APP_BASE_URL", "RENDER_EXTERNAL_URL"]) delete process.env[k];
