const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

// Configuration
const SRC_DIR = './';
const DIST_DIR = './dist';

// Files to minify
const jsFiles = [
    'background.js',
    'popup.js',
    'suspended.js',
    'data_management.js'
];

const htmlFiles = [
    'popup.html',
    'suspended.html',
    'data_management.html'
];

// Clean and create dist folder
console.log('🧹 Cleaning dist folder...');
fs.removeSync(DIST_DIR);
fs.mkdirSync(DIST_DIR, { recursive: true });

// Minify JavaScript files
console.log('📦 Minifying JavaScript...');
jsFiles.forEach(file => {
    const srcPath = path.join(SRC_DIR, file);
    const distPath = path.join(DIST_DIR, file);
    
    if (fs.existsSync(srcPath)) {
        execSync(`npx terser ${srcPath} -o ${distPath} --compress --mangle`);
        console.log(`   ✓ ${file}`);
    } else {
        console.log(`   ⚠ ${file} not found, skipping...`);
    }
});

// Minify HTML files
console.log('📄 Minifying HTML...');
htmlFiles.forEach(file => {
    const srcPath = path.join(SRC_DIR, file);
    const distPath = path.join(DIST_DIR, file);
    
    if (fs.existsSync(srcPath)) {
        execSync(`npx html-minifier-terser --collapse-whitespace --remove-comments --minify-css true --minify-js true -o ${distPath} ${srcPath}`);
        console.log(`   ✓ ${file}`);
    } else {
        console.log(`   ⚠ ${file} not found, skipping...`);
    }
});

// Copy manifest.json (don't minify)
console.log('📋 Copying manifest.json...');
fs.copySync('manifest.json', path.join(DIST_DIR, 'manifest.json'));
console.log('   ✓ manifest.json');

// Copy icons folder
console.log('🖼️  Copying icons...');
fs.copySync('icons', path.join(DIST_DIR, 'icons'));
console.log('   ✓ icons/');

// Build summary
console.log('\n✅ Build complete!');
console.log(`📁 Output folder: ${path.resolve(DIST_DIR)}`);