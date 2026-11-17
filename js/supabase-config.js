/*
  Public browser configuration for Tender Touch.
  Replace these two values with your own Supabase Project URL and anon/publishable key.
  Never put a Supabase service_role/secret key in browser code.
*/
window.TENDER_TOUCH_SUPABASE_URL = 'https://vdeynwgdkzkewmvgqhbu.supabase.co';
window.TENDER_TOUCH_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkZXlud2dka3prZXdtdmdxaGJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4MTc3MDQsImV4cCI6MjA4NzM5MzcwNH0.jEwthweKHthIlEcS20ohbXe2SR1NGSDwABd5qcD-U8Q';

window.createTenderTouchClient = function () {
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    throw new Error('Supabase library did not load. Check your internet connection.');
  }
  return window.supabase.createClient(
    window.TENDER_TOUCH_SUPABASE_URL,
    window.TENDER_TOUCH_SUPABASE_ANON_KEY
  );
};
