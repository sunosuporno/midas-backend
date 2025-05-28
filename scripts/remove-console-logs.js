const fs = require('fs');
const path = require('path');

function processFileContent(content) {
  // Remove all console.* statements
  let newContent = content.replace(
    /console\.(log|error|warn|info|debug)\([^)]*\);?/g,
    '',
  );
  // Remove all logger imports
  newContent = newContent.replace(
    /import\s+\{\s*logger\s*\}\s+from\s+['"].*logger['"];?\n?/g,
    '',
  );
  // Change cron schedule from 15 minutes to 2 minutes
  newContent = newContent.replace(/\*\/15 \* \* \* \*/g, '*/2 * * * *');
  return newContent;
}

function processFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const newContent = processFileContent(content);
    if (newContent !== content) {
      fs.writeFileSync(filePath, newContent);
      console.log(`Processed ${filePath}`);
    }
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
  }
}

function processDirectory(directory) {
  const files = fs.readdirSync(directory);
  files.forEach((file) => {
    const filePath = path.join(directory, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      // Skip node_modules and .git directories
      if (file !== 'node_modules' && file !== '.git') {
        processDirectory(filePath);
      }
    } else if (
      file.endsWith('.ts') ||
      file.endsWith('.tsx') ||
      file.endsWith('.js') ||
      file.endsWith('.jsx')
    ) {
      processFile(filePath);
    }
  });
}

// Process both src and plugins directories
processDirectory(path.join(__dirname, '../src'));
processDirectory(path.join(__dirname, '../workspace/goat-sdk/plugins'));
