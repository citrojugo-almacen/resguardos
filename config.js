// =====================================================================
//  Configuración de conexión — Citrojugo · Resguardo de herramienta
// ---------------------------------------------------------------------
//  Copia aquí los dos valores de tu proyecto de Supabase:
//    Supabase → Project Settings → API (o "Data API" / "API Keys")
//      * Project URL           → supabaseUrl
//      * anon / public key     → supabaseAnonKey  (también llamada "publishable")
//
//  La clave "anon" ES PÚBLICA: está hecha para ir en el navegador. Por sí
//  sola no da acceso a ningún dato; la base exige iniciar sesión y aplica
//  permisos por rol (ver supabase/schema.sql).
//
//  NUNCA pongas aquí la clave "service_role" / "secret": esa da acceso
//  total y solo se usa en tu computadora para migrar datos.
// =====================================================================
window.CITROJUGO_CONFIG = Object.freeze({
  supabaseUrl: "https://svfpdejuhruojytqriji.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2ZnBkZWp1aHJ1b2p5dHFyaWppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4ODg2NzcsImV4cCI6MjEwODQ2NDY3N30.vyBO6G4D00NGm5_3Lo4jSDcqDRrTumpmmFtSA_VMCmw",
  // Minutos sin actividad antes de cerrar la sesión automáticamente.
  inactividadMinutos: 30
});
