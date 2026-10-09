// Brewery OS — where the database is (used by the app and by the menu board page)
//
// The URL and "publishable" key are meant to be public: they let the page talk to the
// database, but the database's row-level security only shows each signed-in person
// their own brewery's data. (The secret keys are never put in this file.)
//
// When the app runs on the developer's own computer (localhost), it uses a private test copy
// of the database running in Docker (`supabase start`), so testing never touches real data.
const ON_THIS_COMPUTER = ["localhost", "127.0.0.1"].includes(location.hostname);
const SUPABASE_URL = ON_THIS_COMPUTER ? "http://127.0.0.1:54321" : "https://itxshxihltidwgwtzdcj.supabase.co";
const SUPABASE_KEY = ON_THIS_COMPUTER
  ? "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH" // the standard key every local Supabase copy uses
  : "sb_publishable_hcERCBatEZUWfy9iret5sw_x2cTAXb5";
