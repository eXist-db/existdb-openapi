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
    before(() => {
      // Install a package whose @version is the literal, unsubstituted
      // "${app.version}" so its repo directory name contains illegal characters.
      // Built and installed via /api/query (see install-malformed-package.xq)
      // because a raw .xar can't be uploaded through the API on plain develop.
      cy.fixture('install-malformed-package.xq', 'utf8').then((query) => {
        cy.request({
          url: '/api/query', method: 'POST', auth,
          body: { query }, timeout: 30000
        }).its('status').should('eq', 200);
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
    it('installs a package from the public repo (JSON registry path)', () => {
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

    // Multipart .xar upload. The fixture is read as a binary string, turned into
    // a byte-preserving Blob, and appended to a FormData "file" part, which
    // cy.request uploads with an auto-generated multipart/form-data boundary.
    //
    // We assert on the upload's HTTP status only, and verify the installed
    // package's identity with a follow-up GET /api/packages/{name}. That keeps
    // the whole flow inside cy.request (same-origin via baseUrl, through the
    // Cypress proxy) — no cross-origin fetch — and reads the deployed state
    // from a plain JSON endpoint instead of relying on the upload response body.
    describe('multipart .xar upload', () => {
      const fixture = 'test-multipart.xar'; // relative to fixturesFolder
      const pkgName = 'http://example.com/test-multipart';

      const uploadXar = () =>
        cy.fixture(fixture, 'binary')
          .then((bin) => Cypress.Blob.binaryStringToBlob(bin, 'application/octet-stream'))
          .then((blob) => {
            const formData = new FormData();
            formData.append('file', blob, 'test-multipart.xar');
            return cy.request({
              url: '/api/packages/install',
              method: 'POST',
              auth,
              body: formData,
              timeout: 30000
            });
          });

      after(() => {
        cy.request({
          url: '/api/packages/test-multipart', method: 'DELETE', auth,
          failOnStatusCode: false
        });
      });

      it('installs and deploys an uploaded .xar', () => {
        uploadXar().its('status').should('eq', 200);
        cy.request({ url: '/api/packages/test-multipart', auth }).then(response => {
          expect(response.body.name).to.eq(pkgName);
          expect(response.body.version).to.eq('1.0.0');
          expect(response.body.abbrev).to.eq('test-multipart');
          expect(response.body.target).to.eq('test-multipart');
        });
      });

      it('appears in GET /api/packages after upload', () => {
        cy.request({ url: '/api/packages', auth }).then(response => {
          expect(JSON.stringify(response.body)).to.contain('test-multipart');
        });
      });

      it('re-uploading a build replaces it idempotently', () => {
        uploadXar().its('status').should('eq', 200);
        cy.request({ url: '/api/packages/test-multipart', auth })
          .its('body.version').should('eq', '1.0.0');
      });

      it('does not leave the temp .xar in /db/system/repo', () => {
        cy.request({
          url: '/exist/rest/db/system/repo/test-multipart.xar',
          auth, failOnStatusCode: false
        }).then(response => {
          expect(response.status).to.eq(404);
        });
      });
    });

    it('still rejects a JSON body missing name/url', () => {
      cy.request({
        url: '/api/packages/install', method: 'POST', auth,
        body: {}, failOnStatusCode: false
      }).then(response => {
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.match(/name, url/);
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
