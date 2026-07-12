import JSZip from 'jszip';

// Collection export: GET /api/db/collection/export streams a collection subtree as
// a ZIP (default) or an installable .xar. Binary resources are stored byte-for-byte;
// XML resources are serialized honoring the caller's params (indent /
// omit-xml-declaration / expand-xincludes / ...), omitted params deferring to the
// conf.xml defaults. These tests unzip the response (JSZip) and assert the entry
// names, the byte-for-byte binary, and the per-entry serialization.

const auth = { username: 'admin', password: '' };
const app = '/db/cypress-export-test';
const plain = '/db/cypress-export-plain'; // a collection with no expath-pkg.xml
const enc = encodeURIComponent;

// Octet-stream content the XML serializer WOULD alter (escape the &<>", reflow the
// whitespace under indent=yes). A binary resource must survive identically, proving
// only XML resources go through the serializer.
const BINARY_CONTENT = 'raw &<>" bytes\n  not-serialized';

// Fixtures are seeded through eXist's native REST (PUT auto-creates the collection
// path, Content-Type decides XML vs binary storage), not the openapi store endpoint.
// This keeps the export tests independent of GET/PUT /api/db/resource — the export
// endpoint is what's under test here, and the seeding shouldn't share its fate.
const origin = new URL(Cypress.config('baseUrl')).origin;

function store(path, content, mime) {
  return cy.request({
    url: `${origin}/exist/rest${path}`,
    method: 'PUT', auth,
    headers: { 'Content-Type': mime || 'application/octet-stream' },
    body: content
  });
}

function rmcol(path) {
  return cy.request({ url: `${origin}/exist/rest${path}`, method: 'DELETE', auth, failOnStatusCode: false });
}

// cy.request with encoding:'binary' yields a latin1 string whose charCodeAt is the
// raw byte; turn it into a Uint8Array JSZip can load.
function exportZip(query, extra) {
  return cy.request(Object.assign({
    url: `/api/db/collection/export?${query}`, auth, encoding: 'binary'
  }, extra || {}));
}

function loadZip(body) {
  const bytes = Uint8Array.from(body, c => c.charCodeAt(0));
  return JSZip.loadAsync(bytes);
}

describe('/api/db/collection/export', () => {
  before(() => {
    rmcol(app);
    rmcol(plain);
    // an EXPath package descriptor at the collection root -> installable .xar
    store(`${app}/expath-pkg.xml`,
      '<package xmlns="http://expath.org/ns/pkg" name="http://exist-db.org/apps/exportapp" abbrev="exportapp" version="1.2.3"><title>Export App</title></package>',
      'application/xml');
    store(`${app}/repo.xml`,
      '<meta xmlns="http://exist-db.org/xquery/repo"><description>Export App</description><type>application</type></meta>',
      'application/xml');
    store(`${app}/data/doc.xml`, '<root><a>1</a><b>2</b></root>', 'application/xml');
    // an XInclude pair to exercise expand-xincludes inside the archive
    store(`${app}/data/xi-target.xml`, '<para>included</para>', 'application/xml');
    store(`${app}/data/xi-including.xml`,
      '<doc xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="xi-target.xml"/></doc>',
      'application/xml');
    // a binary resource whose content the serializer would alter, to prove it isn't
    store(`${app}/data/blob.bin`, BINARY_CONTENT, 'application/octet-stream');

    // the no-package collection used for the xar-without-expath-pkg.xml case
    store(`${plain}/note.xml`, '<note>hi</note>', 'application/xml');
  });

  after(() => {
    rmcol(app);
    rmcol(plain);
  });

  describe('format=zip (default)', () => {
    it('returns application/zip with a Content-Disposition attachment filename', () => {
      exportZip(`path=${enc(app)}`).then(r => {
        expect(r.status).to.eq(200);
        expect(r.headers['content-type']).to.match(/^application\/zip/);
        expect(r.headers['content-disposition']).to.match(/^attachment/);
        expect(r.headers['content-disposition']).to.contain('cypress-export-test.zip');
      });
    });

    it('archives the whole subtree with archive-root-relative entry names', () => {
      exportZip(`path=${enc(app)}`)
        .then(r => loadZip(r.body))
        .then(zip => {
          const names = Object.keys(zip.files);
          expect(names).to.include('expath-pkg.xml');
          expect(names).to.include('repo.xml');
          expect(names).to.include('data/doc.xml');
          expect(names).to.include('data/blob.bin');
          // entries are relative - never carry the absolute /db path
          names.forEach(n => expect(n).to.not.match(/^\/?db\//));
        });
    });

    it('stores binary resources byte-for-byte (not through the serializer)', () => {
      exportZip(`path=${enc(app)}&indent=yes`)
        .then(r => loadZip(r.body))
        .then(zip => zip.file('data/blob.bin').async('string'))
        .then(text => expect(text).to.eq(BINARY_CONTENT));
    });

    it('no serialization params -> conf.xml default (backward compatible)', () => {
      exportZip(`path=${enc(app)}`)
        .then(r => loadZip(r.body))
        .then(zip => zip.file('data/doc.xml').async('string'))
        .then(text => expect(text).to.contain('<a>1</a>'));
    });
  });

  describe('serialization parameters apply to archived XML only', () => {
    it('indent=no keeps XML compact', () => {
      exportZip(`path=${enc(app)}&indent=no`)
        .then(r => loadZip(r.body))
        .then(zip => zip.file('data/doc.xml').async('string'))
        .then(text => expect(text).to.contain('<root><a>1</a><b>2</b></root>'));
    });

    it('indent=yes pretty-prints', () => {
      exportZip(`path=${enc(app)}&indent=yes`)
        .then(r => loadZip(r.body))
        .then(zip => zip.file('data/doc.xml').async('string'))
        .then(text => expect(text).to.match(/<root>\s*\n\s+<a>1<\/a>/));
    });

    it('omit-xml-declaration=no includes the <?xml ...?> declaration', () => {
      exportZip(`path=${enc(app)}&omit-xml-declaration=no`)
        .then(r => loadZip(r.body))
        .then(zip => zip.file('data/doc.xml').async('string'))
        .then(text => expect(text).to.match(/^<\?xml /));
    });

    it('exist:expand-xincludes=no preserves <xi:include> in the archived entry', () => {
      exportZip(`path=${enc(app)}&exist:expand-xincludes=no`)
        .then(r => loadZip(r.body))
        .then(zip => zip.file('data/xi-including.xml').async('string'))
        .then(text => {
          expect(text).to.contain('<xi:include');
          expect(text).to.not.contain('included');
        });
    });

    it('exist:expand-xincludes=yes expands <xi:include> in the archived entry', () => {
      exportZip(`path=${enc(app)}&exist:expand-xincludes=yes`)
        .then(r => loadZip(r.body))
        .then(zip => zip.file('data/xi-including.xml').async('string'))
        .then(text => {
          expect(text).to.contain('<para>included</para>');
          expect(text).to.not.contain('<xi:include');
        });
    });
  });

  describe('format=xar', () => {
    it('names the file <abbrev>-<version>.xar from expath-pkg.xml, with descriptors at the root', () => {
      exportZip(`path=${enc(app)}&format=xar`).then(r => {
        expect(r.status).to.eq(200);
        expect(r.headers['content-disposition']).to.contain('exportapp-1.2.3.xar');
        return loadZip(r.body);
      }).then(zip => {
        // installable: expath-pkg.xml + repo.xml must be at the archive root
        expect(zip.file('expath-pkg.xml')).to.not.be.null;
        expect(zip.file('repo.xml')).to.not.be.null;
      });
    });

    it('a xar request for a collection without expath-pkg.xml is a clean 400', () => {
      cy.request({
        url: `/api/db/collection/export?path=${enc(plain)}&format=xar`,
        auth, failOnStatusCode: false
      }).then(r => {
        expect(r.status).to.eq(400);
        expect(r.body).to.have.property('error');
      });
    });
  });

  describe('errors', () => {
    it('missing path -> 400', () => {
      // `path` is required:true in api.json, so roaster rejects the missing param
      // (its own {code, description} shape) before the handler runs — assert the
      // status, as db.cy.js does for the same roaster-level rejection.
      cy.request({ url: '/api/db/collection/export', auth, failOnStatusCode: false }).then(r => {
        expect(r.status).to.eq(400);
      });
    });

    it('nonexistent collection -> 404', () => {
      cy.request({
        url: `/api/db/collection/export?path=${enc('/db/no-such-collection-xyz')}`,
        auth, failOnStatusCode: false
      }).then(r => {
        expect(r.status).to.eq(404);
        expect(r.body).to.have.property('error');
      });
    });
  });
});
