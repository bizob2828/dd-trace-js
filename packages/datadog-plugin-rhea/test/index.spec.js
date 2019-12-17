'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let tracer

  describe('rhea', () => {
    withVersions(plugin, 'rhea', version => {
      describe('with broker', () => {
        let container
        let context

        beforeEach(() => {
          tracer = require('../../dd-trace')
        })

        afterEach((done) => {
          agent.close()
          agent.wipe()
          context.connection.once('connection_close', () => done())
          context.connection.close()
        })

        describe('without configuration', () => {
          beforeEach(() => agent.load(plugin, 'rhea'))

          beforeEach(done => {
            container = require(`../../../versions/rhea@${version}`).get()

            container.once('sendable', _context => {
              context = _context
              done()
            })
            const connection = container.connect({
              username: 'admin',
              password: 'admin',
              host: 'localhost',
              port: 5673
            })
            connection.open_sender('amq.topic')
            connection.open_receiver('amq.topic')
          })

          describe('sending a message', () => {
            it('should automatically instrument', (done) => {
              agent.use(traces => {
                const span = traces[0][0]
                expect(span).to.include({
                  name: 'amqp.send',
                  resource: 'amq.topic',
                  error: 0,
                  service: 'test-amqp-producer'
                })
                expect(span.meta).to.include({
                  'span.kind': 'producer',
                  'amqp.link.target.address': 'amq.topic',
                  'amqp.link.role': 'sender',
                  'amqp.delivery.state': 'accepted',
                  'out.host': 'localhost',
                  'out.port': '5673'
                })
              })
                .then(done, done)
              context.sender.send({ body: 'Hello World!' })
            })

            it('should inject span context', () => {
              container.on('message', msg => {
                const keys = Object.keys(msg.message.delivery_annotations)
                expect(keys).to.include('x-datadog-trace-id')
                expect(keys).to.include('x-datadog-parent-id')
              })
            })
          })

          describe('receiving a message', () => {
            it('should automatically instrument', done => {
              agent.use(traces => {
                const span = traces[0][0]
                expect(span).to.include({
                  name: 'amqp.receive',
                  resource: 'amq.topic',
                  error: 0,
                  service: 'test'
                })
                expect(span.meta).to.include({
                  'span.kind': 'consumer',
                  'amqp.link.source.address': 'amq.topic',
                  'amqp.link.role': 'receiver'
                })
              })
                .then(done, done)
              context.sender.send({ body: 'Hello World!' })
            })

            it('should extract the span context', done => {
              container.on('message', msg => {
                const span = tracer.scope().active()
                expect(span._spanContext._parentId).to.not.be.null
                done()
              })
              context.sender.send({ body: 'Hello World!' })
            })
          })
        })

        describe('with configuration', () => {
          beforeEach(() => agent.load(plugin, 'rhea', {
            service: 'a_test_service'
          }))

          beforeEach(done => {
            container = require(`../../../versions/rhea@${version}`).get()

            container.once('sendable', function (_context) {
              context = _context
              done()
            })
            const connection = container.connect({
              username: 'admin',
              password: 'admin',
              host: 'localhost',
              port: 5673
            })
            connection.open_sender('amq.topic')
            connection.open_receiver('amq.topic')
          })

          it('should use the configuration', (done) => {
            agent.use(traces => {
              const span = traces[0][0]
              expect(span).to.have.property('service', 'a_test_service')
            })
              .then(done, done)
            context.sender.send({ body: 'Hello World!' })
          })
        })
      })

      describe('without broker', () => {
        let server
        let serverContext
        let client
        let clientContext
        let connection

        beforeEach(() => {
          tracer = require('../../dd-trace')
        })

        afterEach((done) => {
          agent.close()
          agent.wipe()
          if (connection.socket_ready) {
            connection.once('connection_close', () => done())
            connection.close()
          } else {
            done()
          }
        })

        describe('defaults', () => {
          beforeEach(() => agent.load(plugin, 'rhea'))

          beforeEach(done => {
            const rhea = require(`../../../versions/rhea@${version}`).get()

            server = rhea.create_container()
            client = rhea.create_container()

            let sendables = 0

            server.once('sendable', _context => {
              serverContext = _context
              if (++sendables === 2) done()
            })
            client.once('sendable', _context => {
              clientContext = _context
              if (++sendables === 2) done()
            })

            const listener = server.listen({ port: 0 })
            listener.on('listening', () => {
              connection = client.connect(listener.address())
              connection.open_receiver('amq.topic.2')
              connection.open_sender('amq.topic.2')
            })
          })

          describe('client sent message', () => {
            it('receiving', done => {
              const p = expectReceiving(agent)

              server.on('message', msg => {
                p.then(done, done)
              })
              clientContext.sender.send({ body: 'hello' })
            })

            it('sending', done => {
              const p = expectSending(agent, null, 'amq.topic.2')

              server.on('message', msg => {
                p.then(done, done)
              })
              clientContext.sender.send({ body: 'hello' })
            })
          })

          describe('server sent message', () => {
            it('receiving', done => {
              const p = expectReceiving(agent, null, 'amq.topic.2')

              client.on('message', msg => {
                p.then(done, done)
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('sending', done => {
              const p = expectSending(agent)

              client.on('message', msg => {
                p.then(done, done)
              })
              serverContext.sender.send({ body: 'hello' })
            })

            describe('exception in message handler', () => {
              it('span should have error', (done) => {
                const Session = require(`../../../versions/rhea@${version}/node_modules/rhea/lib/session.js`)
                const onTransfer = Session.prototype.on_transfer
                const error = new Error('this is an error')
                Session.prototype.on_transfer = function onTransferWrapped () {
                  try {
                    return onTransfer.apply(this, arguments)
                  } catch (e) {
                    // this is just to prevent mocha from crashing
                  }
                }

                client.on('message', () => {
                  throw error
                })

                agent.use(traces => {
                  const span = traces[0][0]
                  expect(span.error).to.equal(1)
                  expect(span.meta).to.include({
                    'error.msg': 'this is an error',
                    'error.type': 'Error',
                    'error.stack': error.stack
                  })
                  Session.prototype.on_transfer = onTransfer
                }).then(done, done)

                serverContext.sender.send({ body: 'Hello World!' })
              })
            })
          })
        })

        describe('pre-settled', () => {
          beforeEach(() => agent.load(plugin, 'rhea'))

          beforeEach(done => {
            const rhea = require(`../../../versions/rhea@${version}`).get()

            server = rhea.create_container()
            client = rhea.create_container()

            let sendables = 0

            server.once('sendable', _context => {
              serverContext = _context
              if (++sendables === 2) done()
            })
            client.once('sendable', _context => {
              clientContext = _context
              if (++sendables === 2) done()
            })

            const listener = server.listen({ port: 0 })
            listener.on('listening', () => {
              connection = client.connect(listener.address())
              connection.open_receiver()
              connection.open_sender({ snd_settle_mode: 1 })
            })
          })

          describe('client sent message', () => {
            it('sending', done => {
              const p = expectSending(agent, 'accepted')

              server.on('message', msg => {
                p.then(done, done)
              })
              clientContext.sender.send({ body: 'hello' })
            })

            it('receiving', done => {
              const p = expectReceiving(agent)

              server.on('message', msg => {
                p.then(done, done)
              })
              clientContext.sender.send({ body: 'hello' })
            })
          })

          describe('server sent message', () => {
            it('sending', done => {
              const p = expectSending(agent)

              client.on('message', msg => {
                p.then(done, done)
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('receiving', done => {
              const p = expectReceiving(agent)

              client.on('message', msg => {
                p.then(done, done)
              })
              serverContext.sender.send({ body: 'hello' })
            })
          })
        })

        describe('manually settled', () => {
          beforeEach(() => agent.load(plugin, 'rhea'))

          beforeEach(done => {
            const rhea = require(`../../../versions/rhea@${version}`).get()

            server = rhea.create_container()
            client = rhea.create_container()

            server.once('sendable', _context => {
              serverContext = _context
              done()
            })
            const listener = server.listen({ port: 0 })
            listener.on('listening', () => {
              connection = client.connect(listener.address())
              connection.open_receiver({ autoaccept: false })
            })
          })

          describe('server sent message', () => {
            it('sending', done => {
              const p = expectSending(agent)

              client.on('message', msg => {
                msg.delivery.accept()
                p.then(done, done)
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('receiving accepting', done => {
              const p = expectReceiving(agent)

              client.on('message', msg => {
                process.nextTick(() => {
                  msg.delivery.accept()
                  p.then(done, done)
                })
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('receiving rejecting', done => {
              const p = expectReceiving(agent, 'rejected')

              client.on('message', msg => {
                process.nextTick(() => {
                  msg.delivery.reject()
                  p.then(done, done)
                })
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('receiving releasing', done => {
              const p = expectReceiving(agent, 'released')

              client.on('message', msg => {
                process.nextTick(() => {
                  msg.delivery.release()
                  p.then(done, done)
                })
              })
              serverContext.sender.send({ body: 'hello' })
            })

            it('receiving modified', done => {
              const p = expectReceiving(agent, 'modified')

              client.on('message', msg => {
                process.nextTick(() => {
                  msg.delivery.modified()
                  p.then(done, done)
                })
              })
              serverContext.sender.send({ body: 'hello' })
            })
          })
        })

        describe('disconnect', () => {
          beforeEach(() => agent.load(plugin, 'rhea'))

          beforeEach(done => {
            const rhea = require(`../../../versions/rhea@${version}`).get()

            server = rhea.create_container()
            client = rhea.create_container()

            let sendables = 0

            server.once('sendable', _context => {
              serverContext = _context
              if (++sendables === 2) done()
            })
            client.once('sendable', _context => {
              clientContext = _context
              if (++sendables === 2) done()
            })
            const listener = server.listen({ port: 0 })
            listener.on('listening', () => {
              connection = client.connect(Object.assign({ reconnect: false }, listener.address()))
              connection.open_receiver({ autoaccept: false })
              connection.open_sender()
            })
          })

          it('sender span gets closed', (done) => {
            const err = new Error('fake protocol error')
            agent.use(traces => {
              const span = traces[0][0]
              expect(span).to.include({
                name: 'amqp.send',
                resource: 'amq.topic',
                error: 1,
                service: 'test-amqp-producer'
              })
              expect(span.meta).to.include({
                'span.kind': 'producer',
                'amqp.link.target.address': 'amq.topic',
                'amqp.link.role': 'sender',
                'error.type': 'Error',
                'error.msg': 'fake protocol error',
                'error.stack': err.stack
              })
            }).then(done, done)
            connection.output = function () {
              this.on('disconnected', () => {}) // prevent logging the error
              this.saved_error = err
              this.dispatch('protocol_error', err)
              this.socket.end()
            }
            clientContext.sender.send({ body: 'hello' })
          })

          it('receiver span gets closed', (done) => {
            const err = new Error('fake protocol error')
            agent.use(traces => {
              const span = traces[0][0]
              expect(span).to.include({
                name: 'amqp.receive',
                resource: 'amq.topic',
                error: 1,
                service: 'test'
              })
              expect(span.meta).to.include({
                'span.kind': 'consumer',
                'amqp.link.source.address': 'amq.topic',
                'amqp.link.role': 'receiver',
                'error.type': 'Error',
                'error.msg': 'fake protocol error',
                'error.stack': err.stack
              })
            }).then(done, done)
            client.on('message', msg => {
              connection.on('disconnected', () => {}) // prevent logging the error
              connection.saved_error = err
              connection.dispatch('protocol_error', err)
              connection.socket.end()
            })
            serverContext.sender.send({ body: 'hello' })
          })
        })
      })
    })
  })
})

function expectReceiving (agent, deliveryState, topic) {
  deliveryState = deliveryState || 'accepted'
  topic = topic || 'amq.topic'
  return agent.use(traces => {
    const span = traces[0][0]
    expect(span).to.include({
      name: 'amqp.receive',
      resource: topic,
      error: 0,
      service: 'test'
    })
    expect(span.meta).to.include({
      'span.kind': 'consumer',
      'amqp.link.source.address': topic,
      'amqp.link.role': 'receiver',
      'amqp.delivery.state': deliveryState
    })
  })
}

function expectSending (agent, deliveryState, topic) {
  deliveryState = deliveryState || 'accepted'
  topic = topic || 'amq.topic'
  return agent.use(traces => {
    const span = traces[0][0]
    expect(span).to.include({
      name: 'amqp.send',
      resource: topic,
      error: 0,
      service: 'test-amqp-producer'
    })
    expect(span.meta).to.include({
      'span.kind': 'producer',
      'amqp.link.target.address': topic,
      'amqp.link.role': 'sender',
      'amqp.delivery.state': deliveryState
    })
  })
}
