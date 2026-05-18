const { defineConfig } = require('cypress');

module.exports = defineConfig({
  fixturesFolder: 'src/test/cypress/fixtures',
  screenshotsFolder: 'target/cypress/screenshots',
  videosFolder: 'target/cypress/videos',
  downloadsFolder: 'target/cypress/downloads',
  e2e: {
    baseUrl: 'http://localhost:8080/exist/apps/exist-api',
    supportFile: false,
    specPattern: 'src/test/cypress/e2e/**/*.cy.js'
  }
});
