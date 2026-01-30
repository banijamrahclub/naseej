const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data.db');
(async ()=>{
  const hash = await bcrypt.hash('admin123', 10);
  db.run("REPLACE INTO settings (key, value) VALUES ('admin_password', ?)", [hash], ()=>{ console.log('admin password reset to admin123'); db.close(); });
})();
