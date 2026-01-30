const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data.db');

db.run('DELETE FROM bookings', function(err){
  if(err) { console.error('Delete failed', err); process.exit(1); }
  console.log('Deleted rows:', this.changes);
  db.close();
});
