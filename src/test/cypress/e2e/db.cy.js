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

  // ---------------------------------------------------------------------
  // Path-in-URL variant — raw bytes streaming via controller.xq forward
  // to /exist/rest. Used for binary uploads/downloads (PDFs, images,
  // fonts, zips, …) and any large text upload. The JSON envelope at
  // /api/db/resource is unchanged and remains the metadata-bundled path
  // for editors.
  // Closes #35.
  // ---------------------------------------------------------------------
  describe('/api/db/resource/{path} — streaming via controller.xq forward to /exist/rest', () => {
    // These tests exercise the path-in-URL endpoint that forwards to
    // /exist/rest via controller.xq (so the request body streams through
    // to broker.storeDocument without Roaster's body:parse buffering it
    // first). Cypress's cy.request can't cleanly send raw binary bytes
    // (the Buffer ↔ JSON serialization mangles them), so the binary
    // round-trip is verified via curl in the PR description. The text-
    // based tests below exercise the same forward routing — the only
    // type-specific concern (mime auto-detection from the Content-Type
    // header) is covered by the second test.

    it('PUT text via path-in-URL stores at the URL path', () => {
      cy.request({
        url: `/api/db/resource${testCollection}/streamed.txt`,
        method: 'PUT',
        auth,
        headers: { 'Content-Type': 'text/plain' },
        body: 'hello from the streaming endpoint'
      }).then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
      });
      cy.request({
        url: `/api/db/properties?path=${testCollection}/streamed.txt`,
        auth
      }).then(response => {
        // /exist/rest honors the Content-Type header on PUT
        expect(response.body['mime-type']).to.equal('text/plain');
        expect(response.body.type).to.equal('resource');
      });
    });

    it('PUT with application/xquery Content-Type stores as XQuery (no XML parse)', () => {
      cy.request({
        url: `/api/db/resource${testCollection}/streamed.xq`,
        method: 'PUT',
        auth,
        headers: { 'Content-Type': 'application/xquery' },
        body: 'xquery version "3.1"; declare namespace t = "http://t"; 1+1'
      }).then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
      });
      cy.request({
        url: `/api/db/properties?path=${testCollection}/streamed.xq`,
        auth
      }).then(response => {
        expect(response.body['mime-type']).to.equal('application/xquery');
      });
    });

    it('GET on the path-in-URL endpoint returns raw bytes with the stored Content-Type', () => {
      cy.request({
        url: `/api/db/resource${testCollection}/streamed.txt`,
        auth
      }).then(response => {
        expect(response.status).to.equal(200);
        expect(response.headers['content-type']).to.match(/^text\/plain/);
        expect(response.body).to.equal('hello from the streaming endpoint');
      });
    });

    it('DELETE via path-in-URL removes the resource', () => {
      cy.request({
        url: `/api/db/resource${testCollection}/streamed.txt`,
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.status).to.be.oneOf([200, 204]);
      });
      cy.request({
        url: `/api/db/properties?path=${testCollection}/streamed.txt`,
        auth,
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.equal(404);
      });
    });

    it('JSON-envelope endpoint (path-in-body) still works for text — sibling, not replacement', () => {
      // Sanity check that the path-in-URL forward doesn't shadow the
      // bare /api/db/resource endpoint that takes the JSON envelope.
      cy.request({
        url: '/api/db/resource',
        method: 'PUT',
        auth,
        body: { path: `${testCollection}/json-sibling.xml`, content: '<x/>', 'mime-type': 'application/xml' }
      }).then(response => {
        expect(response.status).to.be.oneOf([200, 201]);
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
        body: { source: `${testCollection}/sub/test.xml`, target: `${testCollection}/moved/test.xml` }
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
