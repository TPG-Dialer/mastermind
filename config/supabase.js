/* Supabase connection for api-supabase.js. Both values are safe to publish:
   the anon (publishable) key only allows what the row-level security policies
   allow, and every policy requires a valid session token from the join function.
   Find them in Supabase: Project Settings > API (or > API Keys). */
window.MASTERMIND_SUPABASE = {
  url: 'https://reqfsulfmmrzkzsqthvv.supabase.co',
  anonKey: 'sb_publishable_eWMOGGb0hPcXvku4Qy_wNQ_lQeXlsHg',
  // Web push public key (from `npx web-push generate-vapid-keys`). Leave empty until push is set up.
  vapidPublicKey: '',
  // Set to false to make every write wait for the server before the screen updates.
  optimistic: true
};
