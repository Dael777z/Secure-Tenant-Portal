require('fs').cpSync('db/migrations','dist/db/migrations',{recursive:true})

// Small helper script that ensures migrations make it into the distributed folder, the folder that lives on the servers.

