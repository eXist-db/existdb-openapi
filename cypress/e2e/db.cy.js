const auth = { username: 'admin', password: '' };
const testCollection = '/db/cypress-test-api';

describe('/api/db', () => {
  before(() => {
    // Ensure clean state
    cy.request({
      url: `/api/db/collection?path=${testCollection}&force=true`,
      method: 'DELETE',
      auth,
      failOnStatusCode: false
    });
  });

  after(() => {
    cy.request({
      url: `/api/db/collection?path=${testCollection}&force=true`,
      method: 'DELETE',
      auth,
      failOnStatusCode: false
    });
  });

  describe('GET /api/db — list collections', () => {
    it('lists /db root', () => {
      cy.request({ url: '/api/db?path=/db', auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body.type).to.eq('collection');
        expect(response.body.path).to.eq('/db');
        expect(response.body.children).to.be.an('array');
        expect(response.body).to.have.property('mode');
        expect(response.body).to.have.property('owner');
      });
    });

    it('returns error for nonexistent collection', () => {
      cy.request({ url: '/api/db?path=/db/nonexistent-xyz', auth }).then(response => {
        expect(response.body).to.have.property('error');
      });
    });

    it('supports glob filter', () => {
      cy.request({
        url: '/api/db?path=/db/apps/exist-api/modules&glob=*.xqm',
        auth
      }).then(response => {
        const resources = response.body.children.filter(c => c.type === 'resource');
        resources.forEach(r => {
          expect(r.name).to.match(/\.xqm$/);
        });
      });
    });

    it('supports recursive listing', () => {
      cy.request({
        url: '/api/db?path=/db/apps/exist-api&recursive=true&depth=1',
        auth
      }).then(response => {
        const collections = response.body.children.filter(c => c.type === 'collection');
        expect(collections.length).to.be.greaterThan(0);
      });
    });
  });

  describe('POST /api/db/collection — create', () => {
    it('creates a collection', () => {
      cy.request({
        url: '/api/db/collection',
        method: 'POST',
        auth,
        body: { path: testCollection }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('created');
      });
    });

    it('verifies collection exists', () => {
      cy.request({ url: `/api/db?path=${testCollection}`, auth }).then(response => {
        expect(response.body.type).to.eq('collection');
        expect(response.body.path).to.eq(testCollection);
      });
    });
  });

  describe('PUT /api/db/resource — store', () => {
    it('stores an XML resource', () => {
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: {
          path: `${testCollection}/test.xml`,
          content: '<root><msg>hello</msg></root>',
          'mime-type': 'application/xml'
        }
      }).then(response => {
        expect(response.body).to.have.property('stored');
      });
    });
  });

  describe('GET /api/db/resource — read', () => {
    it('reads back the stored resource', () => {
      cy.request({
        url: `/api/db/resource?path=${testCollection}/test.xml`,
        auth
      }).then(response => {
        expect(response.body.path).to.eq(`${testCollection}/test.xml`);
        expect(response.body.binary).to.eq(false);
        expect(response.body.content).to.include('<msg>hello</msg>');
      });
    });

    it('returns error for nonexistent resource', () => {
      cy.request({
        url: `/api/db/resource?path=${testCollection}/nonexistent.xml`,
        auth
      }).then(response => {
        expect(response.body).to.have.property('error');
      });
    });
  });

  describe('GET /api/db/properties', () => {
    it('returns resource properties', () => {
      cy.request({
        url: `/api/db/properties?path=${testCollection}/test.xml`,
        auth
      }).then(response => {
        expect(response.body.type).to.eq('resource');
        expect(response.body).to.have.property('owner');
        expect(response.body).to.have.property('mode');
        expect(response.body).to.have.property('size');
      });
    });

    it('returns collection properties', () => {
      cy.request({
        url: `/api/db/properties?path=${testCollection}`,
        auth
      }).then(response => {
        expect(response.body.type).to.eq('collection');
        expect(response.body).to.have.property('owner');
      });
    });
  });

  describe('POST /api/db/permissions', () => {
    it('changes permissions on a resource', () => {
      cy.request({
        url: '/api/db/permissions',
        method: 'POST',
        auth,
        body: { path: `${testCollection}/test.xml`, mode: 'rw-rw-r--' }
      }).then(response => {
        expect(response.body).to.have.property('updated');
      });

      cy.request({
        url: `/api/db/properties?path=${testCollection}/test.xml`,
        auth
      }).then(response => {
        expect(response.body.mode).to.eq('rw-rw-r--');
      });
    });
  });

  describe('POST /api/db/copy', () => {
    it('copies a resource to a subcollection', () => {
      // Create target subcollection
      cy.request({
        url: '/api/db/collection',
        method: 'POST',
        auth,
        body: { path: `${testCollection}/sub` }
      });

      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml`, target: `${testCollection}/sub` }
      }).then(response => {
        expect(response.body).to.have.property('copied');
      });

      // Verify copy exists
      cy.request({
        url: `/api/db/resource?path=${testCollection}/sub/test.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<msg>hello</msg>');
      });
    });
  });

  describe('POST /api/db/move', () => {
    it('moves a resource', () => {
      cy.request({
        url: '/api/db/collection',
        method: 'POST',
        auth,
        body: { path: `${testCollection}/moved` }
      });

      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/sub/test.xml`, target: `${testCollection}/moved` }
      }).then(response => {
        expect(response.body).to.have.property('moved');
      });

      // Verify moved
      cy.request({
        url: `/api/db/resource?path=${testCollection}/moved/test.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<msg>hello</msg>');
      });
    });
  });

  describe('DELETE /api/db/resource', () => {
    it('removes a resource', () => {
      cy.request({
        url: `/api/db/resource?path=${testCollection}/test.xml`,
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('removed');
      });
    });

    it('returns error for nonexistent resource', () => {
      cy.request({
        url: `/api/db/resource?path=${testCollection}/nonexistent.xml`,
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.include('not found');
      });
    });

    it('refuses to delete protected paths', () => {
      cy.request({
        url: '/api/db/resource?path=/db/system/config',
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.include('protected');
      });
    });
  });

  describe('DELETE /api/db/collection', () => {
    it('refuses non-empty collection without force', () => {
      cy.request({
        url: `/api/db/collection?path=${testCollection}`,
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.include('not empty');
      });
    });

    it('removes non-empty collection with force', () => {
      cy.request({
        url: `/api/db/collection?path=${testCollection}&force=true`,
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('removed');
      });
    });
  });
});
