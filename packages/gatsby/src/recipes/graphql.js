const express = require(`express`)
const graphqlHTTP = require(`express-graphql`)
const {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  execute,
  subscribe,
} = require(`graphql`)
const { PubSub } = require(`graphql-subscriptions`)
const { SubscriptionServer } = require(`subscriptions-transport-ws`)
const { createServer } = require(`http`)
const { interpret } = require(`xstate`)
const pkgDir = require(`pkg-dir`)

const recipeMachine = require(`./recipe-machine`)
const createTypes = require(`./create-types`)

const SITE_ROOT = pkgDir(process.cwd())

const pubsub = new PubSub()
const PORT = 4000

const emitOperation = state => {
  pubsub.publish(`operation`, {
    state: JSON.stringify(state),
  })
}

// only one service can run at a time.
let service
const applyPlan = plan => {
  const initialState = {
    context: { steps: plan, currentStep: 0 },
    value: `init`,
  }
  emitOperation(initialState)

  // Interpret the machine, and add a listener for whenever a transition occurs.
  service = interpret(
    recipeMachine.withContext(initialState.context)
  ).onTransition(state => {
    // Don't emit again unless there's a state change.
    console.log(`===onTransition`, {
      event: state.event,
      state: state.value,
      context: state.context,
      plan: state.context.plan,
    })
    if (state.changed) {
      console.log(`===state.changed`, {
        state: state.value,
        currentStep: state.context.currentStep,
      })
      emitOperation({
        context: state.context,
        lastEvent: state.event,
        value: state.value,
      })
    }
  })

  // Start the service
  try {
    service.start()
  } catch (e) {
    console.log(`recipe machine failed to start`, e)
  }
}

const OperationType = new GraphQLObjectType({
  name: `Operation`,
  fields: {
    state: { type: GraphQLString },
  },
})

const types = createTypes()

const rootQueryType = new GraphQLObjectType({
  name: `Root`,
  fields: () => types,
})

const rootMutationType = new GraphQLObjectType({
  name: `Mutation`,
  fields: () => {
    return {
      createOperation: {
        type: GraphQLString,
        args: {
          commands: { type: GraphQLString },
        },
        resolve: (_data, args) => {
          const commands = JSON.parse(args.commands)
          console.log(`received operation`, commands)
          applyPlan(commands)
        },
      },
      sendEvent: {
        type: GraphQLString,
        args: {
          event: { type: GraphQLString },
        },
        resolve: (_, args) => {
          console.log(`event received`, args)
          service.send(args.event)
        },
      },
    }
  },
})

const rootSubscriptionType = new GraphQLObjectType({
  name: `Subscription`,
  fields: () => {
    return {
      operation: {
        type: OperationType,
        subscribe: () => pubsub.asyncIterator(`operation`),
        resolve: payload => payload,
      },
    }
  },
})

const schema = new GraphQLSchema({
  query: rootQueryType,
  mutation: rootMutationType,
  subscription: rootSubscriptionType,
})

const app = express()
const server = createServer(app)

console.log(`listening on localhost:4000`)

app.use(
  `/graphql`,
  graphqlHTTP({
    schema,
    graphiql: true,
    context: { root: SITE_ROOT },
  })
)

server.listen(PORT, () => {
  new SubscriptionServer(
    {
      execute,
      subscribe,
      schema,
    },
    {
      server,
      path: `/graphql`,
    }
  )
})
