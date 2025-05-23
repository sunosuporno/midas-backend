const fs = require('fs');
const path = require('path');

function removeConsoleLogs(directory) {
  const files = fs.readdirSync(directory);

  files.forEach((file) => {
    const filePath = path.join(directory, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // Skip node_modules and .git directories
      if (file !== 'node_modules' && file !== '.git') {
        removeConsoleLogs(filePath);
      }
    } else if (file.endsWith('.ts')) {
      let content = fs.readFileSync(filePath, 'utf8');

      // Remove console.log statements
      content = content.replace(/console\.log\([^)]*\);?/g, '');
      // Remove console.error statements
      content = content.replace(/console\.error\([^)]*\);?/g, '');
      // Remove console.warn statements
      content = content.replace(/console\.warn\([^)]*\);?/g, '');
      // Remove console.info statements
      content = content.replace(/console\.info\([^)]*\);?/g, '');

      fs.writeFileSync(filePath, content);
      console.log(`Processed ${filePath}`);
    }
  });
}

// Start from src directory
removeConsoleLogs(path.join(__dirname, '../src'));
