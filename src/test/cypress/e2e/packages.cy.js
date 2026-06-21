const auth = { username: 'admin', password: '' };

describe('/api/packages', () => {
  describe('GET /api/packages', () => {
    it('lists installed packages with rich metadata', () => {
      cy.request({ url: '/api/packages', auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
        expect(response.body.length).to.be.greaterThan(0);

        const pkg = response.body[0];
        expect(pkg).to.have.property('uri');
        expect(pkg).to.have.property('name');
        expect(pkg).to.have.property('abbrev');
        expect(pkg).to.have.property('version');
        expect(pkg).to.have.property('components');
      });
    });
  });

  // Regression: a package whose version was never substituted at build time is
  // stored under "/db/system/repo/<abbrev>-${app.version}/", a directory name
  // that contains characters illegal in an XMLDB path. The deployment-date lookup
  // used a bare doc() on that path, which threw FODC0005 and failed the WHOLE
  // listing with HTTP 500. The listing must now tolerate one bad package.
  describe('GET /api/packages — resilient to a malformed installed package', () => {
    // Install a package whose @version is the literal, unsubstituted
    // "${app.version}" so its repo directory name contains illegal characters.
    // Built and installed via /api/query because a raw .xar can't be uploaded
    // through the API on plain develop. Single-quoted lines keep ${...}/{$ver}
    // literal (no JS template interpolation).
    const setupQuery = [
      'let $ver := "${app.version}"',
      'let $pkg :=',
      '    <package xmlns="http://expath.org/ns/pkg" name="http://example.com/badver" abbrev="badver" version="{$ver}" spec="1.0">',
      '        <title>Bad Version Package</title>',
      '    </package>',
      'let $repo :=',
      '    <meta xmlns="http://exist-db.org/xquery/repo">',
      '        <description>Bad version repro</description>',
      '        <type>library</type>',
      '        <status>stable</status>',
      '    </meta>',
      'let $entries := (',
      '    <entry name="expath-pkg.xml" type="xml">{$pkg}</entry>,',
      '    <entry name="repo.xml" type="xml">{$repo}</entry>',
      ')',
      'let $zip := compression:zip($entries, true())',
      'let $stored := xmldb:store("/db/system/repo", "badver-setup.xar", $zip, "application/zip")',
      'return repo:install-and-deploy-from-db($stored, "https://exist-db.org/exist/apps/public-repo/find")/@target/string()'
    ].join('\n');

    before(() => {
      cy.request({
        url: '/api/query', method: 'POST', auth,
        body: { query: setupQuery }, timeout: 30000
      }).then(response => {
        expect(response.status).to.eq(200);
      });
    });

    after(() => {
      cy.request({
        url: '/api/packages/badver?force=true', method: 'DELETE', auth,
        failOnStatusCode: false
      });
    });

    it('returns 200 and still includes the malformed package', () => {
      cy.request({ url: '/api/packages', auth }).then(response => {
        expect(response.status).to.eq(200);
        const bad = response.body.find(p => p && p.abbrev === 'badver');
        expect(bad, 'malformed package present in listing').to.exist;
        expect(bad.version).to.eq('${app.version}');
      });
    });
  });

  describe('GET /api/packages/{name}', () => {
    it('gets package details by abbreviation with full metadata', () => {
      cy.request({
        url: '/api/packages/existdb-openapi',
        auth
      }).then(response => {
        expect(response.body.abbrev).to.eq('existdb-openapi');
        expect(response.body).to.have.property('components');
        expect(response.body).to.have.property('version');
        expect(response.body).to.have.property('name');
      });
    });

    it('gets package details by abbreviation', () => {
      cy.request({
        url: '/api/packages/existdb-openapi',
        auth
      }).then(response => {
        expect(response.body.abbrev).to.eq('existdb-openapi');
      });
    });

    it('returns error for nonexistent package', () => {
      cy.request({
        url: '/api/packages/nonexistent-package-xyz',
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(404);
        expect(response.body).to.have.property('error');
      });
    });
  });

  describe('POST /api/packages/install', () => {
    it('installs a package from the public repo', () => {
      cy.request({
        url: '/api/packages/install',
        method: 'POST',
        auth,
        body: {
          name: 'http://www.functx.com',
          url: 'https://exist-db.org/exist/apps/public-repo/find'
        },
        timeout: 30000
      }).then(response => {
        expect(response.body).to.have.property('success', true);
        expect(response.body.result).to.have.property('target');
      });
    });
  });

  describe('POST /api/packages/update-check', () => {
    it('checks for package updates', () => {
      cy.request({
        url: '/api/packages/update-check',
        method: 'POST',
        auth,
        body: {},
        timeout: 30000
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('registry');
        expect(response.body).to.have.property('updates');
        expect(response.body.updates).to.be.an('array');
      });
    });

    it('accepts custom registry URL', () => {
      cy.request({
        url: '/api/packages/update-check',
        method: 'POST',
        auth,
        body: { registry: 'https://exist-db.org/exist/apps/public-repo' },
        timeout: 30000
      }).then(response => {
        expect(response.body.registry).to.eq('https://exist-db.org/exist/apps/public-repo');
      });
    });
  });

  describe('DELETE /api/packages/{name}', () => {
    it('reports dependents when they exist', () => {
      // semver-xq has dependents (packageservice depends on it)
      cy.request({
        url: '/api/packages/semver-xq',
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('dependents');
        expect(response.body).to.have.property('hint');
      });
    });
  });
});
