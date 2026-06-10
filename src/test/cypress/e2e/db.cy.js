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
    it('stores an XML resource with explicit mime-type', () => {
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

    // Regression: prior to this fix the handler defaulted `mime-type` to
    // "application/xml" when the client omitted it, so .xq / .xqm / .svg
    // / .json content either failed the XML parse outright (XPST0003,
    // "Content is not allowed in prolog") or stored with the wrong MIME.
    // The fix drops the default and lets the 3-arg xmldb:store consult
    // eXist's MimeTable to pick the right MIME from the extension.
    it('auto-detects application/xquery from .xq extension when mime-type omitted', () => {
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: { path: `${testCollection}/auto.xq`, content: 'xquery version "3.1"; 1+1' }
      }).then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
        expect(response.body).to.have.property('stored');
      });
      cy.request({
        url: `/api/db/properties?path=${testCollection}/auto.xq`,
        auth
      }).then(response => {
        expect(response.body['mime-type']).to.equal('application/xquery');
      });
    });

    it('auto-detects application/xquery from .xqm extension when mime-type omitted', () => {
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: {
          path: `${testCollection}/auto.xqm`,
          content: 'xquery version "3.1"; module namespace t = "http://example.com/t";'
        }
      }).then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
      });
      cy.request({
        url: `/api/db/properties?path=${testCollection}/auto.xqm`,
        auth
      }).then(response => {
        expect(response.body['mime-type']).to.equal('application/xquery');
      });
    });

    it('auto-detects image/svg+xml from .svg extension when mime-type omitted', () => {
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: {
          path: `${testCollection}/auto.svg`,
          content: '<svg xmlns="http://www.w3.org/2000/svg"/>'
        }
      });
      cy.request({
        url: `/api/db/properties?path=${testCollection}/auto.svg`,
        auth
      }).then(response => {
        expect(response.body['mime-type']).to.equal('image/svg+xml');
      });
    });

    it('auto-detects application/json from .json extension when mime-type omitted', () => {
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: { path: `${testCollection}/auto.json`, content: '{"hello":"world"}' }
      });
      cy.request({
        url: `/api/db/properties?path=${testCollection}/auto.json`,
        auth
      }).then(response => {
        expect(response.body['mime-type']).to.equal('application/json');
      });
    });

    it('stores well-formed .html as text/html via auto-detection', () => {
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: {
          path: `${testCollection}/wellformed.html`,
          content: '<html><head><title>t</title></head><body><p>x</p></body></html>'
        }
      }).then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
        expect(response.body).to.have.property('stored');
      });
      cy.request({
        url: `/api/db/properties?path=${testCollection}/wellformed.html`,
        auth
      }).then(response => {
        expect(response.body['mime-type']).to.equal('text/html');
      });
    });

    it('returns 400 with a parse-error message for unparseable XML content', () => {
      // Unclosed <img> — not well-formed XML. eXist's text/html is
      // an XML-class mime, so the parser runs and rejects. Clients
      // who need to preserve raw bytes should send
      // mime-type=application/octet-stream explicitly.
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: {
          path: `${testCollection}/bad.html`,
          content: '<html><body><img src="x.png"></body></html>'
        },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(400);
        expect(response.body.error).to.match(/parser|XML|img/i);
      });
    });

    it('preserves raw bytes for unparseable content when mime-type=application/octet-stream', () => {
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: {
          path: `${testCollection}/raw.html`,
          content: '<html><body><img src="x.png"></body></html>',
          'mime-type': 'application/octet-stream'
        }
      }).then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
      });
      cy.request({
        url: `/api/db/properties?path=${testCollection}/raw.html`,
        auth
      }).then(response => {
        expect(response.body['mime-type']).to.equal('application/octet-stream');
      });
    });

    it('still honors explicit mime-type override (e.g. xhtml+xml for an .html path)', () => {
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: {
          path: `${testCollection}/explicit.html`,
          content: '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>x</p></body></html>',
          'mime-type': 'application/xhtml+xml'
        }
      });
      cy.request({
        url: `/api/db/properties?path=${testCollection}/explicit.html`,
        auth
      }).then(response => {
        expect(response.body['mime-type']).to.equal('application/xhtml+xml');
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
    // Dedicated resource so these tests don't perturb (or get perturbed by)
    // earlier permissions tweaks on /test.xml above.
    const permResource = `${testCollection}/perm.xml`;
    const permSubCollection = `${testCollection}/perm-sub`;

    before(() => {
      // Resource for resource-permission tests
      cy.request({
        url: '/api/db/resource', method: 'PUT', auth,
        body: { path: permResource, content: '<r/>', 'mime-type': 'application/xml' }
      });
      // Sub-collection for collection-permission tests
      cy.request({
        url: '/api/db/collection', method: 'POST', auth,
        body: { path: permSubCollection }
      });
    });

    it('changes mode on a resource (rwxrwxrwx-style)', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, mode: 'rw-rw-r--' }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('updated', permResource);
      });

      cy.request({ url: `/api/db/properties?path=${permResource}`, auth })
        .then(response => {
          expect(response.body.mode).to.eq('rw-rw-r--');
        });
    });

    it('changes owner on a resource', () => {
      // admin → guest, then back to admin so later tests aren't affected
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, owner: 'guest' }
      }).then(response => {
        expect(response.body).to.have.property('updated');
      });
      cy.request({ url: `/api/db/properties?path=${permResource}`, auth })
        .then(response => {
          expect(response.body.owner).to.eq('guest');
        });

      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, owner: 'admin' }
      });
    });

    it('changes group on a resource', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, group: 'guest' }
      });
      cy.request({ url: `/api/db/properties?path=${permResource}`, auth })
        .then(response => {
          expect(response.body.group).to.eq('guest');
        });

      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, group: 'dba' }
      });
    });

    it('applies owner + group + mode in a single request', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: {
          path: permResource,
          owner: 'guest', group: 'guest', mode: 'rw-r-----'
        }
      }).then(response => {
        expect(response.status).to.eq(200);
      });

      cy.request({ url: `/api/db/properties?path=${permResource}`, auth })
        .then(response => {
          expect(response.body.owner).to.eq('guest');
          expect(response.body.group).to.eq('guest');
          expect(response.body.mode).to.eq('rw-r-----');
        });

      // Restore
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, owner: 'admin', group: 'dba', mode: 'rw-rw-r--' }
      });
    });

    it('changes mode on a collection', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permSubCollection, mode: 'rwxr-x---' }
      }).then(response => {
        expect(response.body).to.have.property('updated', permSubCollection);
      });

      cy.request({ url: `/api/db/properties?path=${permSubCollection}`, auth })
        .then(response => {
          expect(response.body.type).to.eq('collection');
          expect(response.body.mode).to.eq('rwxr-x---');
        });
    });

    it('rejects octal mode strings (sm:chmod does not accept them)', () => {
      // Documenting the contract: sm:chmod only accepts the symbolic
      // rwxrwxrwx-style and relative forms (u+x, g-w, etc.) — NOT octal
      // strings like "0644" or "644". Clients that want to send a numeric
      // mode must convert it to the rwxrwxrwx form first.
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: permResource, mode: '0644' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.be.at.least(400);
        const body = response.body;
        const msg = (body.description || body.error || '').toLowerCase();
        expect(msg).to.match(/mode|syntax/);
      });
    });

    it('returns HTTP 400 when path is missing', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { mode: 'rw-rw-r--' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(400);
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.match(/path/i);
      });
    });

    it('returns an error for a nonexistent path', () => {
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth,
        body: { path: '/db/does-not-exist-xyz.xml', mode: 'rw-rw-r--' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.be.at.least(400);
        const body = response.body;
        expect(body.description || body.error).to.exist;
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

  describe('awkward resource names (encode/decode boundary)', () => {
    // The API speaks DECODED UTF-8 on the wire both ways: a client sends/receives
    // "café déjà.xml", never "caf%C3%A9...". eXist stores names percent-encoded,
    // so db.xqm encodes on input and decodes on output. The other db tests use
    // ASCII names and so don't exercise this boundary.
    // non-ASCII + space; sub-delim apostrophe (xmldb:store leaves it literal); literal "+"
    // (must survive: stored as a literal "+", decoded back to "+", NOT form-decoded to a space)
    const NAMES = ['café déjà.xml', "o'brien.xml", 'naïve+test.xml'];

    before(() => {
      cy.request({
        url: '/api/db/collection', method: 'POST', auth, failOnStatusCode: false,
        body: { path: testCollection }
      });
    });

    NAMES.forEach(name => {
      const path = `${testCollection}/${name}`;
      const q = encodeURIComponent(path);

      it(`stores, reads, lists and removes a resource named "${name}" by its decoded name`, () => {
        // store with the decoded name in the body
        cy.request({
          url: '/api/db/resource', method: 'PUT', auth,
          body: { path, content: `<doc>${name}</doc>`, 'mime-type': 'application/xml' }
        }).then(r => expect(r.status).to.be.oneOf([200, 201]));

        // read back BY the decoded name: path echoes decoded, content intact
        cy.request({ url: `/api/db/resource?path=${q}`, auth }).then(r => {
          expect(r.body.path).to.eq(path);
          expect(r.body.content).to.include(name);
        });

        // listing shows the decoded name (not percent-encoded)
        cy.request({ url: `/api/db?path=${encodeURIComponent(testCollection)}`, auth }).then(r => {
          const names = r.body.children.map(c => c.name);
          expect(names, 'decoded name appears in listing').to.include(name);
          names.forEach(n =>
            expect(n, 'listing names are decoded, not percent-encoded').to.not.match(/%[0-9A-Fa-f]{2}/)
          );
        });

        // remove BY the decoded name
        cy.request({ url: `/api/db/resource?path=${q}`, method: 'DELETE', auth }).then(r => {
          expect(r.status).to.be.oneOf([200, 204]);
        });
      });
    });
  });

  // Gap features folded into db-core (audit §2 items 2–6): writable flag and
  // start/count pagination on list (always-on), runPath always on get-resource,
  // meta=full single-call content+metadata, and set-MIME via /permissions.
  describe('db-core gap features (audit §2 items 2–6)', () => {
    const gaps = `${testCollection}/gaps`;
    const enc = p => encodeURIComponent(p);

    before(() => {
      cy.request({ url: '/api/db/collection', method: 'POST', auth, failOnStatusCode: false, body: { path: testCollection } });
      cy.request({ url: '/api/db/collection', method: 'POST', auth, failOnStatusCode: false, body: { path: gaps } });
      ['a.xml', 'b.xml', 'c.xml'].forEach(n =>
        cy.request({ url: '/api/db/resource', method: 'PUT', auth, body: { path: `${gaps}/${n}`, content: '<doc/>', 'mime-type': 'application/xml' } })
      );
    });

    after(() => {
      cy.request({ url: `/api/db/collection?path=${enc(gaps)}&force=true`, method: 'DELETE', auth, failOnStatusCode: false });
    });

    it('item 3 — every list item carries a writable boolean', () => {
      cy.request({ url: `/api/db?path=${enc(gaps)}`, auth }).then(r => {
        expect(r.body.children).to.have.length.greaterThan(0);
        r.body.children.forEach(c => expect(c.writable, `writable on ${c.name}`).to.be.a('boolean'));
      });
    });

    it('item 5 — flat listing carries total/start/count and the default is all children', () => {
      cy.request({ url: `/api/db?path=${enc(gaps)}`, auth }).then(r => {
        expect(r.body).to.have.property('total', 3);
        expect(r.body).to.have.property('start', 1);
        expect(r.body).to.have.property('count', 3);
        expect(r.body.children).to.have.length(3);
      });
    });

    it('item 5 — start/count slices the child sequence; total stays the full count', () => {
      cy.request({ url: `/api/db?path=${enc(gaps)}&start=2&count=1`, auth }).then(r => {
        expect(r.body.total).to.eq(3);
        expect(r.body.start).to.eq(2);
        expect(r.body.count).to.eq(1);
        expect(r.body.children).to.have.length(1);
        expect(r.body.children[0].name).to.eq('b.xml');
      });
    });

    it('item 6 — get-resource always returns runPath', () => {
      cy.request({ url: `/api/db/resource?path=${enc(`${gaps}/a.xml`)}`, auth }).then(r => {
        expect(r.body).to.have.property('runPath').that.is.a('string').and.match(/^\/exist\//);
      });
    });

    it('item 2 — meta=full flattens metadata alongside the content', () => {
      cy.request({ url: `/api/db/resource?path=${enc(`${gaps}/a.xml`)}&meta=full`, auth }).then(r => {
        // content fields still present
        expect(r.body).to.have.property('content');
        expect(r.body).to.have.property('runPath');
        // metadata flattened in (same keys /properties returns for a resource)
        ['owner', 'group', 'mode', 'acl', 'size', 'created', 'last-modified'].forEach(k =>
          expect(r.body, `meta key ${k}`).to.have.property(k)
        );
      });
    });

    it('item 2 — without meta=full the metadata keys are absent (default unchanged)', () => {
      cy.request({ url: `/api/db/resource?path=${enc(`${gaps}/a.xml`)}`, auth }).then(r => {
        expect(r.body).to.not.have.property('owner');
        expect(r.body).to.not.have.property('last-modified');
      });
    });

    it('item 4 — set MIME type via POST /api/db/permissions (compatible class)', () => {
      // a.xml is stored as XML, so a compatible (XML-class) mime is accepted
      const path = `${gaps}/a.xml`;
      cy.request({ url: '/api/db/permissions', method: 'POST', auth, body: { path, mime: 'text/html' } })
        .then(r => expect(r.status).to.eq(200));
      cy.request({ url: `/api/db/properties?path=${enc(path)}`, auth }).then(r => {
        expect(r.body['mime-type']).to.eq('text/html');
      });
    });

    it('item 4 — a mime incompatible with the resource storage class is a clean 400', () => {
      // eXist forbids a binary-class mime on an XML-stored resource; surface 400, not 500
      cy.request({
        url: '/api/db/permissions', method: 'POST', auth, failOnStatusCode: false,
        body: { path: `${gaps}/b.xml`, mime: 'application/json' }
      }).then(r => {
        expect(r.status).to.eq(400);
        expect(r.body).to.have.property('error');
      });
    });
  });
});
