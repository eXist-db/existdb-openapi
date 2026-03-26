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

  describe('GET /api/packages/{name}', () => {
    it('gets package details by URI', () => {
      cy.request({
        url: '/api/packages/http%3A%2F%2Fexist-db.org%2Fpkg%2Fapi',
        auth
      }).then(response => {
        expect(response.body.abbrev).to.eq('exist-api');
        expect(response.body).to.have.property('components');
      });
    });

    it('gets package details by abbreviation', () => {
      cy.request({
        url: '/api/packages/exist-api',
        auth
      }).then(response => {
        expect(response.body.abbrev).to.eq('exist-api');
      });
    });

    it('returns error for nonexistent package', () => {
      cy.request({
        url: '/api/packages/nonexistent-package-xyz',
        auth
      }).then(response => {
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
        url: '/api/packages/http%3A%2F%2Fexist-db.org%2Fxquery%2Fsemver-xq',
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('dependents');
        expect(response.body).to.have.property('hint');
      });
    });
  });
});
