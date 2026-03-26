describe('/api/system', () => {
  describe('GET /api/system/info', () => {
    it('returns database version info', () => {
      cy.request({
        url: '/api/system/info',
        auth: { username: 'admin', password: '' }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('db');
        expect(response.body.db).to.have.property('name');
        expect(response.body.db).to.have.property('version');
        expect(response.body.db).to.have.property('git');
      });
    });

    it('returns Java info', () => {
      cy.request({
        url: '/api/system/info',
        auth: { username: 'admin', password: '' }
      }).then(response => {
        expect(response.body).to.have.property('java');
        expect(response.body.java).to.have.property('version');
        expect(response.body.java).to.have.property('vendor');
      });
    });

    it('returns OS info', () => {
      cy.request({
        url: '/api/system/info',
        auth: { username: 'admin', password: '' }
      }).then(response => {
        expect(response.body).to.have.property('os');
        expect(response.body.os).to.have.property('name');
        expect(response.body.os).to.have.property('arch');
      });
    });
  });

  describe('GET /api/system/scheduler', () => {
    it('returns scheduled jobs', () => {
      cy.request({
        url: '/api/system/scheduler',
        auth: { username: 'admin', password: '' }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('jobs');
        expect(response.body.jobs).to.be.an('array');
        expect(response.body.jobs.length).to.be.greaterThan(0);
        const job = response.body.jobs[0];
        expect(job).to.have.property('name');
        expect(job).to.have.property('group');
      });
    });
  });
});
