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
      cy.request({ url: '/api/db?path=/db/nonexistent-xyz', auth, failOnStatusCode: false }).then(response => {
        expect(response.status).to.eq(404);
        expect(response.body).to.have.property('error');
      });
    });

    it('supports glob filter', () => {
      cy.request({
        url: '/api/db?path=/db/apps/existdb-openapi/modules&glob=*.xqm',
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
        url: '/api/db?path=/db/apps/existdb-openapi&recursive=true&depth=1',
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
        expect(response.status).to.be.oneOf([200, 201]);
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
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(404);
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
    it('copies a resource into an existing collection (parent only, leaf preserved)', () => {
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
        body: { source: `${testCollection}/test.xml`, parent: `${testCollection}/sub` }
      }).then(response => {
        expect(response.body).to.have.property('copied');
        expect(response.body.to).to.equal(`${testCollection}/sub/test.xml`);
      });

      cy.request({
        url: `/api/db/resource?path=${testCollection}/sub/test.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<msg>hello</msg>');
      });
    });

    it('copies a resource into an existing collection with a new name (parent + name)', () => {
      cy.request({
        url: '/api/db/collection',
        method: 'POST',
        auth,
        body: { path: `${testCollection}/copy-rename` }
      });
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: {
          source: `${testCollection}/test.xml`,
          parent: `${testCollection}/copy-rename`,
          name: 'test-renamed.xml'
        }
      }).then(response => {
        expect(response.body).to.have.property('copied');
        expect(response.body.to).to.equal(`${testCollection}/copy-rename/test-renamed.xml`);
      });
      cy.request({
        url: `/api/db/resource?path=${testCollection}/copy-rename/test-renamed.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<msg>hello</msg>');
      });
    });

    it('duplicates a resource in place via newName (shortcut)', () => {
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml`, newName: 'test-dup.xml' }
      }).then(response => {
        expect(response.body).to.have.property('copied');
        expect(response.body.to).to.equal(`${testCollection}/test-dup.xml`);
      });
      cy.request({
        url: `/api/db/resource?path=${testCollection}/test-dup.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<msg>hello</msg>');
      });
    });

    it('duplicates a collection in place via newName (shortcut)', () => {
      cy.request({
        url: '/api/db/collection',
        method: 'POST',
        auth,
        body: { path: `${testCollection}/coll-to-dup` }
      });
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: { path: `${testCollection}/coll-to-dup/child.xml`, content: '<child>hi</child>', 'mime-type': 'application/xml' }
      });
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/coll-to-dup`, newName: 'coll-duplicated' }
      }).then(response => {
        expect(response.body).to.have.property('copied');
        expect(response.body.to).to.equal(`${testCollection}/coll-duplicated`);
      });
      cy.request({
        url: `/api/db/resource?path=${testCollection}/coll-duplicated/child.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<child>hi</child>');
      });
    });

    it('rejects copy when both parent and newName are missing', () => {
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml` },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/parent or newName/i);
      });
    });

    it('rejects copy when parent does not exist', () => {
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml`, parent: `${testCollection}/no-such-collection` },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/does not exist/i);
      });
    });

    it('rejects copy when destination matches source (no-op collision)', () => {
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml`, parent: testCollection },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/matches source|new name/i);
      });
    });
  });

  describe('POST /api/db/move', () => {
    it('moves a resource into an existing collection (parent only, leaf preserved)', () => {
      cy.request({
        url: '/api/db/collection',
        method: 'POST',
        auth,
        body: { path: `${testCollection}/dest-coll` }
      });
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: { path: `${testCollection}/in-dest.xml`, content: '<msg>moveme</msg>', 'mime-type': 'application/xml' }
      });
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/in-dest.xml`, parent: `${testCollection}/dest-coll` }
      }).then(response => {
        expect(response.body).to.have.property('moved');
        expect(response.body.to).to.equal(`${testCollection}/dest-coll/in-dest.xml`);
      });
      cy.request({
        url: `/api/db/resource?path=${testCollection}/dest-coll/in-dest.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<msg>moveme</msg>');
      });
    });

    it('moves a resource with rename (parent + name)', () => {
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
        body: {
          source: `${testCollection}/sub/test.xml`,
          parent: `${testCollection}/moved`,
          name: 'arrived.xml'
        }
      }).then(response => {
        expect(response.body).to.have.property('moved');
        expect(response.body.to).to.equal(`${testCollection}/moved/arrived.xml`);
      });
      cy.request({
        url: `/api/db/resource?path=${testCollection}/moved/arrived.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<msg>hello</msg>');
      });
    });

    it('renames a resource in place via newName (shortcut)', () => {
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: { path: `${testCollection}/to-rename.xml`, content: '<msg>rename me</msg>', 'mime-type': 'application/xml' }
      });
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/to-rename.xml`, newName: 'renamed.xml' }
      }).then(response => {
        expect(response.body).to.have.property('moved');
        expect(response.body.to).to.equal(`${testCollection}/renamed.xml`);
      });
      cy.request({
        url: `/api/db/resource?path=${testCollection}/renamed.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<msg>rename me</msg>');
      });
      cy.request({
        url: `/api/db/resource?path=${testCollection}/to-rename.xml`,
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(404);
      });
    });

    it('renames a collection in place via newName (shortcut)', () => {
      cy.request({
        url: '/api/db/collection',
        method: 'POST',
        auth,
        body: { path: `${testCollection}/coll-old` }
      });
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/coll-old`, newName: 'coll-new' }
      }).then(response => {
        expect(response.body).to.have.property('moved');
        expect(response.body.to).to.equal(`${testCollection}/coll-new`);
      });
    });

    it('rejects move when both parent and newName are missing', () => {
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml` },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/parent or newName/i);
      });
    });

    it('rejects move when parent does not exist', () => {
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/test.xml`, parent: `${testCollection}/no-such-collection` },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/does not exist/i);
      });
    });

    // Closes #37 — was the original silent-data-loss case.
    it('refuses to overwrite an existing destination on move (409 Conflict, source preserved)', () => {
      // Set up: a source resource and a different file at the proposed destination
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: { path: `${testCollection}/src-overwrite.xml`, content: '<src/>', 'mime-type': 'application/xml' }
      });
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: { path: `${testCollection}/dest-blocking.xml`, content: '<dest>existing</dest>', 'mime-type': 'application/xml' }
      });
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/src-overwrite.xml`, parent: testCollection, name: 'dest-blocking.xml' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(409);
        expect(response.body.error).to.match(/already exists/i);
      });
      // Source must still be there.
      cy.request({
        url: `/api/db/resource?path=${testCollection}/src-overwrite.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<src/>');
      });
      // Destination must be unchanged (NOT overwritten with source).
      cy.request({
        url: `/api/db/resource?path=${testCollection}/dest-blocking.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<dest>existing</dest>');
      });
    });

    it('refuses to overwrite an existing destination collection on move (409 Conflict)', () => {
      cy.request({
        url: '/api/db/collection',
        method: 'POST',
        auth,
        body: { path: `${testCollection}/coll-src-overwrite` }
      });
      cy.request({
        url: '/api/db/collection',
        method: 'POST',
        auth,
        body: { path: `${testCollection}/coll-dest-blocking` }
      });
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/coll-src-overwrite`, parent: testCollection, name: 'coll-dest-blocking' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(409);
        expect(response.body.error).to.match(/already exists/i);
      });
      // Both collections still there.
      cy.request({
        url: `/api/db?path=${testCollection}/coll-src-overwrite`,
        auth
      }).then(response => {
        expect(response.body.type).to.equal('collection');
      });
      cy.request({
        url: `/api/db?path=${testCollection}/coll-dest-blocking`,
        auth
      }).then(response => {
        expect(response.body.type).to.equal('collection');
      });
    });

    it('rejects move when source does not exist (404)', () => {
      cy.request({
        url: '/api/db/move',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/no-such-source.xml`, parent: testCollection, name: 'irrelevant.xml' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(404);
        expect(response.body.error).to.match(/not found/i);
      });
    });
  });

  describe('POST /api/db/copy — safety', () => {
    it('refuses to overwrite an existing destination on copy (409 Conflict, both preserved)', () => {
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: { path: `${testCollection}/copy-src.xml`, content: '<src/>', 'mime-type': 'application/xml' }
      });
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: { path: `${testCollection}/copy-dest-blocking.xml`, content: '<dest/>', 'mime-type': 'application/xml' }
      });
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/copy-src.xml`, parent: testCollection, name: 'copy-dest-blocking.xml' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(409);
        expect(response.body.error).to.match(/already exists/i);
      });
      cy.request({
        url: `/api/db/resource?path=${testCollection}/copy-src.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<src/>');
      });
      cy.request({
        url: `/api/db/resource?path=${testCollection}/copy-dest-blocking.xml`,
        auth
      }).then(response => {
        expect(response.body.content).to.include('<dest/>');
      });
    });

    it('rejects copy when source does not exist (404)', () => {
      cy.request({
        url: '/api/db/copy',
        method: 'POST',
        auth,
        body: { source: `${testCollection}/no-such-source.xml`, parent: testCollection, name: 'x.xml' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(404);
        expect(response.body.error).to.match(/not found/i);
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
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(404);
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.include('not found');
      });
    });

    it('refuses to delete protected paths', () => {
      cy.request({
        url: '/api/db/resource?path=/db/system/config',
        method: 'DELETE',
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(403);
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
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(409);
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
